/** Protocol regressions for issues 16-18, grounded in pyatv 0.18.0. No hardware is used. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppleTV, Key } from '../appletv.js';
import { MRPMessage, MessageType } from '../mrp/messages.js';
import type { OpackDict, OpackValue } from '../companion/opack.js';

function device() {
  return new AppleTV({ name: 'TV', address: '127.0.0.1', port: 7000, deviceId: 'test', model: 'test' });
}
function mrp(atv: AppleTV) {
  const sent: any[] = [];
  (atv as any).connection = { close: vi.fn(), sendMRPMessage: async (buf: Buffer) => {
    const message = await MRPMessage.decode(buf);
    sent.push(message);
  } };
  return sent;
}
function companion(atv: AppleTV) {
  const sent: [string, OpackDict][] = [];
  const conn = { close: vi.fn(), sendRequest: vi.fn(async (id: string, content: OpackDict) => {
    sent.push([id, content]);
    return new Map<OpackValue, OpackValue>([['_c', new Map([['_sid', 7]])]]);
  }), sendMessage: vi.fn((id: string, content: OpackDict) => { sent.push([id, content]); }) };
  (atv as any).companionConnection = conn;
  return { sent, conn };
}
afterEach(() => vi.useRealTimers());

describe('button actions', () => {
  it('double tap sends two complete HID press/release/flush sequences', async () => {
    const atv = device(); const sent = mrp(atv);
    await (atv.up as any)('doubleTap');
    expect(sent.map(m => m.type)).toEqual([8, 8, MessageType.GenericMessage, 8, 8, MessageType.GenericMessage]);
  });
  it('holds for one second and preserves the 50ms default', async () => {
    vi.useFakeTimers(); const atv = device(); const sent = mrp(atv);
    const promise = (atv.home as any)('hold');
    await vi.advanceTimersByTimeAsync(999); expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await promise; expect(sent).toHaveLength(3);
  });
  it('rejects unknown actions and non-button action modes without sending', async () => {
    const atv = device(); const sent = mrp(atv);
    await expect((atv.up as any)('bad')).rejects.toThrow(/action/i);
    await expect((atv.sendKeyCommand as any)(Key.Play, 'hold')).rejects.toThrow(/support/i);
    expect(sent).toEqual([]);
  });
});

describe('Companion gestures', () => {
  it('starts touch and remote service before sending timestamped touch events, then stops both', async () => {
    const atv = device(); const { sent } = companion(atv);
    await (atv as any).touchAction(100, 200, 1);
    await (atv as any).touchAction(100, 200, 4);
    await (atv as any).stopTouch();
    expect(sent.map(([id]) => id)).toEqual(['_touchStart', '_sessionStart', '_hidT', '_hidT', '_sessionStop', '_touchStop']);
    expect(sent[0][1]).toEqual(new Map([['_height', 1000], ['_tFl', 0], ['_width', 1000]]));
    expect(sent[2][1].get('_tPh')).toBe(1);
    expect(sent[2][1].get('_ns')).toBeTypeOf('bigint');
    expect(sent[4][1].get('_sid')).toBeTypeOf('bigint');
  });
  it('click uses Companion select down/up and phase 5 at 1000,1000', async () => {
    const atv = device(); const { sent } = companion(atv);
    await (atv as any).click('doubleTap');
    expect(sent.slice(2).map(([id, c]) => [id, c.get('_hBtS') ?? c.get('_tPh')])).toEqual([
      ['_hidC', 1], ['_hidC', 2], ['_hidT', 5], ['_hidC', 1], ['_hidC', 2], ['_hidT', 5],
    ]);
  });
  it('swipe emits press, interpolated holds and endpoint release', async () => {
    vi.useFakeTimers(); const atv = device(); const { sent } = companion(atv);
    const promise = (atv as any).swipe(0, 100, 1000, 900, 32);
    await vi.runAllTimersAsync(); await promise;
    const events = sent.filter(([id]) => id === '_hidT').map(([, c]) => c);
    expect(events.map(c => c.get('_tPh'))).toEqual([1, 3, 4]);
    expect(events.at(-1)?.get('_cx')).toBe(1000);
    expect(events.at(-1)?.get('_cy')).toBe(900);
  });
  it('cancellation releases the finger and rejects instead of reporting completion', async () => {
    vi.useFakeTimers(); const atv = device(); const { sent } = companion(atv);
    const controller = new AbortController();
    const promise = (atv as any).swipe(0, 0, 1000, 1000, 1000, controller.signal);
    const rejected = expect(promise).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(16); controller.abort();
    await vi.runAllTimersAsync(); await rejected;
    expect(sent.filter(([id]) => id === '_hidT').at(-1)?.[1].get('_tPh')).toBe(4);
  });
  it('invalid inputs never start a session', async () => {
    const atv = device(); const { sent } = companion(atv);
    await expect((atv as any).touchAction(-1, 0, 1)).rejects.toThrow(/coordinate/i);
    await expect((atv as any).swipe(0, 0, 1, 1, NaN)).rejects.toThrow(/duration/i);
    expect(sent).toEqual([]);
  });
  it('session startup errors propagate and roll back touch registration', async () => {
    const atv = device(); const { sent, conn } = companion(atv);
    conn.sendRequest.mockImplementation(async (id, c) => {
      sent.push([id, c]);
      return id === '_sessionStart' ? new Map([['_em', 'unsupported']]) : new Map([['_c', new Map()]]);
    });
    await expect((atv as any).touchAction(0, 0, 1)).rejects.toThrow(/unsupported/);
    expect(sent.map(([id]) => id)).toEqual(['_touchStart', '_sessionStart', '_touchStop']);
  });
});

describe('output routing', () => {
  it('decodes independent grouped-device field 28 from the wire', async () => {
    // Protocol type 37, extension 20 with groupedDevices(name="S",deviceUID="x").
    const message = await MRPMessage.decode(Buffer.from('0825a2010e12025456e201071201539a010178', 'hex')) as any;
    expect(message['.deviceInfoMessage'].groupedDevices[0].deviceUID).toBe('x');
  });
  it('lists current reported outputs and emits only changed groups', () => {
    const atv = device(); const seen: unknown[] = []; atv.on('outputDevices', d => seen.push(d));
    const message = { type: 37, '.deviceInfoMessage': { name: 'TV', uniqueIdentifier: 'tv', isGroupLeader: true,
      groupedDevices: [{ name: 'Speaker', deviceUID: 'speaker' }] } };
    (atv as any).handleMRPMessage(message); (atv as any).handleMRPMessage(message);
    expect((atv as any).outputDevices).toEqual([{ name: 'TV', identifier: 'tv' }, { name: 'Speaker', identifier: 'speaker' }]);
    expect(seen).toHaveLength(1);
  });
  it.each(['add', 'remove', 'set'])('%s sends type 65 and both cluster-aware fields; waits for reported state', async mode => {
    const atv = device(); const sent = mrp(atv);
    (atv as any).handleMRPMessage({ type: 15, '.deviceInfoMessage': { groupedDevices: mode === 'remove' ? [{ name: 'S', deviceUID: 'speaker' }] : [] } });
    let done = false;
    const promise = (atv as any)[`${mode}OutputDevices`](['speaker']).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false);
    expect(sent[0].type).toBe(65);
    const field = { add: 'addingDevices', remove: 'removingDevices', set: 'settingDevices' }[mode]!;
    expect(sent[0]['.modifyOutputContextRequestMessage'][field]).toEqual(['speaker']);
    expect(sent[0]['.modifyOutputContextRequestMessage'][`clusterAware${field[0].toUpperCase()}${field.slice(1)}`]).toEqual(['speaker']);
    (atv as any).handleMRPMessage({ type: 37, '.deviceInfoMessage': { groupedDevices: mode === 'remove' ? [] : [{ name: 'S', deviceUID: 'speaker' }] } });
    await promise;
  });
  it('routing timeout rejects and never mutates reported outputs', async () => {
    vi.useFakeTimers(); const atv = device(); mrp(atv);
    const promise = (atv as any).setOutputDevices(['s']);
    const rejected = expect(promise).rejects.toThrow(/confirm|timeout/i);
    await vi.runAllTimersAsync(); await rejected; expect((atv as any).outputDevices).toEqual([]);
  });
  it('correlated unsupported response rejects routing', async () => {
    const atv = device(); const sent = mrp(atv);
    const promise = (atv as any).addOutputDevices(['s']);
    const rejected = expect(promise).rejects.toThrow(/unsupported/i);
    await new Promise(resolve => setImmediate(resolve));
    (atv as any).handleMRPMessage({ type: 66, identifier: sent[0].identifier, errorCode: 1, errorDescription: 'unsupported' });
    await rejected;
  });
});

describe('cleanup and independent wire evidence', () => {
  it('close rejects routing, clears its timer and permits a new operation', async () => {
    vi.useFakeTimers(); const atv = device(); mrp(atv);
    const pending = atv.addOutputDevices(['s']);
    const rejected = expect(pending).rejects.toThrow(/closed/i);
    await vi.advanceTimersByTimeAsync(0); await atv.close(); await rejected;
    expect(vi.getTimerCount()).toBe(0);
    mrp(atv); const next = atv.setOutputDevices([]);
    await vi.advanceTimersByTimeAsync(0);
    (atv as any).handleMRPMessage({ type: 37, '.deviceInfoMessage': { groupedDevices: [] } });
    await next;
  });
  it('failed touch shutdown still closes both transports', async () => {
    const atv = device(); mrp(atv); const { conn } = companion(atv);
    await atv.touchAction(0, 0, 1);
    conn.sendRequest.mockRejectedValue(new Error('shutdown rejected'));
    const airplay = (atv as any).connection;
    await expect(atv.close()).rejects.toThrow('shutdown rejected');
    expect(conn.close).toHaveBeenCalledOnce(); expect(airplay.close).toHaveBeenCalledOnce();
    expect((atv as any).touchSession).toBeUndefined();
  });
  it('pins add and set payload extension and field numbers independent of decoding', async () => {
    const add = await MRPMessage.modifyOutputDevices('add', ['x']);
    const set = await MRPMessage.modifyOutputDevices('set', ['x']);
    expect(add.subarray(add.indexOf(Buffer.from('a203', 'hex'))).toString('hex')).toBe('a2030808011201782a0178');
    expect(set.subarray(set.indexOf(Buffer.from('a203', 'hex'))).toString('hex')).toBe('a2030808012201783a0178');
    expect(add.subarray(0, 2).toString('hex')).toBe('0841');
  });
  it('decodes correlated rejection fields 4 and 78 from independent bytes', async () => {
    const message = await MRPMessage.decode(Buffer.from('08421201692001f2040b756e737570706f72746564', 'hex'));
    expect(message.type).toBe(66); expect(message.identifier).toBe('i');
    expect(message.errorCode).toBe(1); expect(message.errorDescription).toBe('unsupported');
  });
});

describe('review regression guards', () => {
  it('rejects concurrent routing without replacing the first waiter', async () => {
    const atv = device(); mrp(atv);
    const first = atv.addOutputDevices(['s']);
    const second = atv.addOutputDevices(['other']);
    const rejected = expect(second).rejects.toThrow(/pending/);
    await new Promise(resolve => setImmediate(resolve));
    (atv as any).handleMRPMessage({ type: 37, '.deviceInfoMessage': { groupedDevices: [{ name: 'S', deviceUID: 's' }] } });
    await first; await rejected;
  });
  it('keeps outputs when a DeviceInfoUpdate contains only volume identity', () => {
    const atv = device();
    (atv as any).handleMRPMessage({ type: 15, '.deviceInfoMessage': { groupedDevices: [{ name: 'S', deviceUID: 's' }] } });
    (atv as any).handleMRPMessage({ type: 37, '.deviceInfoMessage': { deviceUID: 'tv' } });
    expect(atv.outputDevices).toEqual([{ name: 'S', identifier: 's' }]);
  });
  it('stopTouch waits for startup before stopping the new registration', async () => {
    const atv = device(); const { sent } = companion(atv);
    const start = atv.touchAction(1, 1, 1);
    const stop = atv.stopTouch(); await start; await stop;
    expect(sent.map(([id]) => id)).toContain('_sessionStop');
    expect((atv as any).touchSession).toBeUndefined();
  });
  it('a failed release does not leave gestures permanently busy', async () => {
    vi.useFakeTimers(); const atv = device(); const { conn } = companion(atv);
    conn.sendMessage.mockImplementation((id, content) => {
      if (content.get('_tPh') === 4) throw new Error('release failed');
    });
    const promise = atv.swipe(0, 0, 10, 10, 16);
    const rejected = expect(promise).rejects.toThrow('release failed');
    await vi.runAllTimersAsync(); await rejected;
    expect((atv as any).activeTouch).toBeUndefined(); expect((atv as any).gestureBusy).toBe(false);
  });
});

describe('gesture cancellation and input lifecycle', () => {
  it('rejects pressing twice without a release', async () => {
    const atv = device(); companion(atv); await atv.touchAction(0, 0, 1);
    await expect(atv.touchAction(1, 1, 1)).rejects.toThrow(/pressed/);
  });
  it('stopTouch cancels a held click and releases the select button', async () => {
    vi.useFakeTimers(); const atv = device(); const { sent } = companion(atv);
    const click = atv.click('hold'); const rejected = expect(click).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(20); await atv.stopTouch();
    await vi.runAllTimersAsync(); await rejected;
    expect(sent.filter(([id]) => id === '_hidC').map(([, c]) => c.get('_hBtS'))).toEqual([1, 2]);
  });
});

it('retains both touch teardown errors and clears registrations', async () => {
  const atv = device(); const { conn } = companion(atv);
  await atv.touchAction(0, 0, 1);
  conn.sendRequest.mockImplementation(async id => { throw new Error(`${id} failed`); });
  const error = await atv.stopTouch().catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map((entry: Error) => entry.message)).toEqual(['_sessionStop failed', '_touchStop failed']);
  expect((atv as any).touchSession).toBeUndefined();
});

it('reports missing Companion before starting a touch gesture', async () => {
  await expect(device().touchAction(1, 2, 1)).rejects.toThrow('Companion not connected');
});
it('rejects concurrent low-level presses after shared touch startup', async () => {
  const atv = device(); const { sent } = companion(atv);
  const result = await Promise.allSettled([atv.touchAction(1, 2, 1), atv.touchAction(3, 4, 1)]);
  expect(result.map(entry => entry.status)).toEqual(['fulfilled', 'rejected']);
  expect(sent.filter(([id]) => id === '_hidT')).toHaveLength(1);
  await atv.stopTouch();
});
