/** Offline MRP reply correlation and unsolicited handshake regression tests. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import protobuf from 'protobufjs';
import { AirPlayConnection } from '../connection.js';
import { MRPMessage, MessageType } from '../mrp/messages.js';
import { MRP_SCHEMA } from '../mrp/schema.js';

const protocol = protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace).lookupType('ProtocolMessage');
const credentials = { clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) };
function connection() {
  const conn = new AirPlayConnection('offline', 7000, credentials);
  vi.spyOn(conn, 'sendMRPMessage').mockResolvedValue();
  return conn;
}
async function reply(conn: AirPlayConnection, identifier?: string, type = MessageType.SetState) {
  await (conn as any).handleMRPResponse(Buffer.from(protocol.encode(protocol.create({ type, identifier })).finish()));
}
afterEach(() => vi.useRealTimers());

describe('MRP correlation', () => {
  it('matches concurrent same-type replies by UUID in reverse order', async () => {
    const conn = connection();
    const first = await MRPMessage.playbackQueueRequest();
    const second = await MRPMessage.playbackQueueRequest();
    const a = conn.sendMRPMessageAndWait(first, MessageType.SetState);
    const b = conn.sendMRPMessageAndWait(second, MessageType.SetState);
    const firstId = (await MRPMessage.decode(first)).identifier as string;
    const secondId = (await MRPMessage.decode(second)).identifier as string;
    await reply(conn, secondId);
    await reply(conn, firstId);
    expect((await a).identifier).toBe(firstId);
    expect((await b).identifier).toBe(secondId);
    conn.close();
  });

  it('observes unsolicited messages without satisfying requests or wrong response types', async () => {
    vi.useFakeTimers();
    const conn = connection();
    const observed: unknown[] = [];
    conn.on('mrp-message', msg => observed.push(msg));
    const request = await MRPMessage.playbackQueueRequest();
    const id = (await MRPMessage.decode(request)).identifier as string;
    let settled = false;
    const pending = conn.sendMRPMessageAndWait(request, MessageType.SetState).then(msg => { settled = true; return msg; });
    await reply(conn);
    await reply(conn, 'unrelated');
    await reply(conn, id, MessageType.DeviceInfo);
    expect(settled).toBe(false);
    expect(observed).toHaveLength(3);
    await reply(conn, id);
    expect((await pending).identifier).toBe(id);
    conn.close();
  });

  it('timeout removes only its own same-type handshake waiter', async () => {
    vi.useFakeTimers();
    const conn = connection();
    const long = (conn as any).waitForMRPMessage(MessageType.DeviceInfo, 1000);
    const short = (conn as any).waitForMRPMessage(MessageType.DeviceInfo, 10);
    const rejection = expect(short).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    await reply(conn, undefined, MessageType.DeviceInfo);
    let resolved = false;
    void long.then(() => { resolved = true; }, () => {});
    await Promise.resolve();
    expect(resolved).toBe(true);
    conn.close();
  });

  it('registers DeviceInfo before writing and accepts identifierless handshake replies', async () => {
    vi.useFakeTimers();
    const conn = connection();
    vi.mocked(conn.sendMRPMessage).mockImplementation(async data => {
      if ((await MRPMessage.decode(data)).type === MessageType.DeviceInfo) await reply(conn, undefined, MessageType.DeviceInfo);
    });
    let connected = false;
    const init = (conn as any).initMRPProtocol().then(() => { connected = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(connected).toBe(true);
    await init;
    conn.close();
  });

  it('cancels the response timer on write failure', async () => {
    vi.useFakeTimers();
    const conn = connection();
    vi.mocked(conn.sendMRPMessage).mockRejectedValue(new Error('write failed'));
    await expect(conn.sendMRPMessageAndWait(await MRPMessage.playbackQueueRequest(), MessageType.SetState)).rejects.toThrow('write failed');
    expect(vi.getTimerCount()).toBe(0);
    conn.close();
  });
});
it('late UUID replies cannot satisfy a newer request after timeout', async () => {
  vi.useFakeTimers();
  const conn = connection();
  const old = await MRPMessage.playbackQueueRequest();
  const oldId = (await MRPMessage.decode(old)).identifier as string;
  const timeout = expect(conn.sendMRPMessageAndWait(old, MessageType.SetState, 10)).rejects.toThrow('Timeout');
  await vi.advanceTimersByTimeAsync(10);
  await timeout;
  const next = await MRPMessage.playbackQueueRequest();
  const nextId = (await MRPMessage.decode(next)).identifier as string;
  let resolved = false;
  const pending = conn.sendMRPMessageAndWait(next, MessageType.SetState).then(msg => { resolved = true; return msg; });
  await reply(conn, oldId);
  expect(resolved).toBe(false);
  await reply(conn, nextId);
  expect((await pending).identifier).toBe(nextId);
  conn.close();
});
it('rejects concurrent reuse of an identifier without disturbing the original waiter', async () => {
  const conn = connection();
  const request = await MRPMessage.playbackQueueRequest();
  const identifier = (await MRPMessage.decode(request)).identifier as string;
  const first = conn.sendMRPMessageAndWait(request, MessageType.SetState);
  await expect(conn.sendMRPMessageAndWait(request, MessageType.SetState)).rejects.toThrow(/already pending/i);
  await reply(conn, identifier);
  expect((await first).identifier).toBe(identifier);
  conn.close();
});
describe('sanitized MRP diagnostics', () => {
  it('distinguishes pushes, wrong-type replies and correlated replies without disclosing media', async () => {
    const conn = connection();
    const observed: Record<string, unknown>[] = [];
    conn.on('mrp-diagnostic', diagnostic => observed.push(diagnostic));
    const request = await MRPMessage.playbackQueueRequest();
    const identifier = (await MRPMessage.decode(request)).identifier as string;
    const pending = conn.sendMRPMessageAndWait(request, MessageType.SetState);
    await Promise.resolve();
    const payload = { playerPath: { client: { bundleIdentifier: 'private.app' }, player: { identifier: 'private-player' } }, nowPlayingInfo: { title: 'Private title', artist: 'Private artist' }, playbackQueue: { contentItems: [{ identifier: 'private-track', artworkData: Buffer.from('secret artwork') }] } };
    await (conn as any).handleMRPResponse(Buffer.from(protocol.encode(protocol.create({ type: 4, '.setStateMessage': payload })).finish()));
    await reply(conn, identifier, MessageType.DeviceInfo);
    await (conn as any).handleMRPResponse(Buffer.from(protocol.encode(protocol.create({ type: 4, identifier, '.setStateMessage': payload })).finish()));
    await pending;
    expect(observed).toHaveLength(4);
    expect(observed[0]).toEqual({ direction: 'send', type: 32, identifier: 'request-1' });
    expect(observed[1]).toEqual({ direction: 'receive', type: 4, matchedRequest: false, client: 'client-2', player: 'player-3' });
    expect(observed[2]).toEqual({ direction: 'receive', type: 15, identifier: 'request-1', matchedRequest: false });
    expect(observed[3]).toEqual({ direction: 'receive', type: 4, identifier: 'request-1', matchedRequest: true, client: 'client-2', player: 'player-3' });
    expect(JSON.stringify(observed)).not.toMatch(/private|Private|secret/);
    conn.close();
  });

  it('bounds the token map while keeping tokens unique', async () => {
    const conn = connection();
    const tokens = new Set<unknown>();
    conn.on('mrp-diagnostic', diagnostic => tokens.add(diagnostic.identifier));
    for (let i = 0; i < 1500; i++) (conn as any).emitDiagnostic('send', { type: MessageType.SetConnectionState, identifier: `id-${i}` });
    expect(tokens.size).toBe(1500);
    expect((conn as any).diagnosticIds.size).toBeLessThanOrEqual(1024);
    conn.close();
  });

  it('excludes auth and unrelated message types entirely', async () => {
    const conn = connection();
    const observed: unknown[] = [];
    conn.on('mrp-diagnostic', diagnostic => observed.push(diagnostic));
    for (const type of [MessageType.CryptoPairing, MessageType.Keyboard, MessageType.TextInput, MessageType.GenericMessage]) {
      await reply(conn, 'not-for-export', type);
    }
    // A closed proto2 enum can leave only an inherited default. It is not a received type.
    (conn as any).emitDiagnostic('receive', Object.create({ type: MessageType.SetState }));
    (conn as any).emitDiagnostic('receive', {});
    expect(observed).toEqual([]);
    conn.close();
  });

  it('does not let diagnostic observer exceptions skip state delivery or the handshake', async () => {
    const conn = connection();
    conn.on('mrp-diagnostic', () => { throw new Error('observer failed'); });
    const received: unknown[] = [];
    conn.on('mrp-message', msg => received.push(msg));
    vi.mocked(conn.sendMRPMessage).mockImplementation(async data => {
      const request = await MRPMessage.decode(data);
      if (request.type === MessageType.DeviceInfo) await reply(conn, undefined, MessageType.DeviceInfo);
      if (request.type === MessageType.PlaybackQueueRequest) await reply(conn, request.identifier as string);
    });
    await expect((conn as any).initMRPProtocol()).resolves.toBeUndefined();
    await expect(conn.sendMRPMessageAndWait(await MRPMessage.playbackQueueRequest(), MessageType.SetState)).resolves.toMatchObject({ type: 4 });
    expect(received).toHaveLength(2);
    conn.close();
  });

  it('captures relevant init sends and identifierless handshake matches', async () => {
    const conn = connection();
    const observed: Record<string, unknown>[] = [];
    conn.on('mrp-diagnostic', diagnostic => observed.push(diagnostic));
    vi.mocked(conn.sendMRPMessage).mockImplementation(async data => {
      if ((await MRPMessage.decode(data)).type === MessageType.DeviceInfo) await reply(conn, undefined, MessageType.DeviceInfo);
    });
    await (conn as any).initMRPProtocol();
    expect(observed.map(item => [item.direction, item.type, item.matchedRequest])).toEqual([
      ['send', 15, undefined], ['receive', 15, true], ['send', 38, undefined], ['send', 16, undefined], ['send', 24, undefined],
    ]);
    conn.close();
  });
});

it('rejects identifierless application requests before creating response timers', async () => {
  vi.useFakeTimers();
  const conn = connection();
  const request = Buffer.from(protocol.encode(protocol.create({ type: MessageType.PlaybackQueueRequest })).finish());
  await expect(conn.sendMRPMessageAndWait(request, MessageType.SetState)).rejects.toThrow(/identifier/i);
  expect(vi.getTimerCount()).toBe(0);
  conn.close();
});
