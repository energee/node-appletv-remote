/** Offline AirPlay transport loss, pending work, and heartbeat ownership tests. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { AirPlayConnection } from '../connection.js';
import { MRPMessage, MessageType } from '../mrp/messages.js';
const credentials = { clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) };
function setup() {
  const conn = new AirPlayConnection('offline', 7000, credentials);
  const socket = Object.assign(new EventEmitter(), { write: vi.fn(), destroy: vi.fn() });
  (conn as any).socket = socket;
  return { conn, socket };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('close rejects raw HTTP, RTSP and MRP waiters and removes timers/listeners', async () => {
  vi.useFakeTimers();
  const { conn } = setup();
  vi.spyOn(conn, 'sendMRPMessage').mockResolvedValue();
  const raw = (conn as any).httpPostOnSocket('/pair-verify', Buffer.alloc(0));
  const rtsp = (conn as any).sendRTSP('RECORD', '/');
  const mrp = conn.sendMRPMessageAndWait(await MRPMessage.playbackQueueRequest(), MessageType.SetState);
  await Promise.resolve();
  const outcomes = Promise.all([raw, rtsp, mrp].map(p => p.then(() => 'resolved', (e: Error) => e.message)));
  conn.close();
  conn.close();
  let results: string[] | undefined;
  void outcomes.then(value => { results = value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(results).toHaveLength(3);
  expect(results?.every(value => /closed/i.test(value))).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(conn.listenerCount('rtsp-response')).toBe(0);
});
it('registers RTSP before writing and correlates concurrent replies by CSeq', async () => {
  const { conn, socket } = setup();
  socket.write.mockImplementation((_data, callback) => { callback?.(); });
  const a = (conn as any).sendRTSP('RECORD', '/');
  const b = (conn as any).sendRTSP('POST', '/feedback');
  conn.emit('rtsp-response', { headers: { cseq: '2' }, body: Buffer.from('second') });
  conn.emit('rtsp-response', { headers: { cseq: '1' }, body: Buffer.from('first') });
  expect((await a).body.toString()).toBe('first');
  expect((await b).body.toString()).toBe('second');
  conn.close();
});
it('never overlaps a stalled heartbeat and close stops scheduling', async () => {
  vi.useFakeTimers();
  const { conn, socket } = setup();
  (conn as any).startFeedbackHeartbeat();
  await vi.advanceTimersByTimeAsync(6000);
  expect(socket.write).toHaveBeenCalledTimes(1);
  conn.close();
  await vi.advanceTimersByTimeAsync(6000);
  expect(socket.write).toHaveBeenCalledTimes(1);
});
it('propagates decrypt failure and immediately clears pending work', async () => {
  vi.useFakeTimers();
  const { conn } = setup();
  const errors: Error[] = [];
  conn.on('error', error => errors.push(error));
  (conn as any).dataSession = { decryptAvailable() { throw new Error('bad tag'); } };
  const waiter = (conn as any).waitForMRPMessage(MessageType.DeviceInfo).catch((e: Error) => e.message);
  (conn as any).onDataChannelData(Buffer.from('bad'));
  expect(errors.map(e => e.message).join()).toContain('bad tag');
  let result: string | undefined;
  void waiter.then((message: string) => { result = message; });
  await vi.advanceTimersByTimeAsync(0);
  expect(result).toContain('bad tag');
  expect(vi.getTimerCount()).toBe(0);
  conn.close();
});
it.each(['control', 'event', 'data'])('loss of %s socket rejects pending work once', async (channel) => {
  vi.useFakeTimers();
  const { conn, socket } = setup();
  if (channel !== 'control') (conn as any).socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  if (channel !== 'control') (conn as any)[`${channel}Socket`] = socket;
  (conn as any).watchSocket(socket);
  let closes = 0;
  conn.on('close', () => { closes++; });
  const pending = (conn as any).waitForMRPMessage(MessageType.DeviceInfo).catch((e: Error) => e.message);
  socket.emit('end');
  socket.emit('close');
  expect(await pending).toMatch(/closed/i);
  expect(closes).toBe(1);
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('consumes coalesced RTSP responses instead of dropping the second', async () => {
  vi.useFakeTimers();
  const { conn } = setup();
  const first = (conn as any).sendRTSP('RECORD', '/');
  const second = (conn as any).sendRTSP('POST', '/feedback');
  let value: string | undefined;
  void second.then((reply: any) => { value = reply.body.toString(); }, () => {});
  (conn as any).onEncryptedData(Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 3\r\n\r\noneRTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Length: 3\r\n\r\ntwo'));
  expect((await first).body.toString()).toBe('one');
  await vi.advanceTimersByTimeAsync(0);
  expect(value).toBe('two');
  conn.close();
});
it('close settles a pending MRP write even without a write callback', async () => {
  vi.useFakeTimers();
  const { conn, socket } = setup();
  (conn as any).dataSocket = socket;
  (conn as any).dataSession = { encrypt: (data: Buffer) => data };
  let outcome: string | undefined;
  void conn.sendMRPMessage(await MRPMessage.playbackQueueRequest()).catch(e => { outcome = e.message; });
  conn.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(outcome).toMatch(/closed/i);
});

it.each(['abc', '-1', '1x', '1.5', '9007199254740992'])('rejects invalid Content-Length %s on every HTTP channel', (length) => {
  for (const channel of ['raw', 'rtsp', 'event']) {
    const { conn } = setup();
    const errors: Error[] = [];
    conn.on('error', error => errors.push(error));
    // Stop the old infinite loop deterministically rather than hanging the runner.
    let replies = 0;
    conn.on('rtsp-response', () => { if (++replies > 2) throw new Error('parser made no progress'); });
    const data = Buffer.from(`RTSP/1.0 200 OK\r\nContent-Length: ${length}\r\n\r\nx`);
    const input = () => {
      if (channel === 'raw') (conn as any).onRawData(data);
      if (channel === 'rtsp') (conn as any).onEncryptedData(data);
      if (channel === 'event') {
        (conn as any).eventSession = { decryptAvailable: () => ({ plaintext: data, rest: Buffer.alloc(0) }), encrypt() { throw new Error('invalid request acknowledged'); } };
        (conn as any).onEventChannelData(data);
      }
    };
    expect(input).not.toThrow();
    expect(errors[0]?.message).toMatch(/Content-Length/i);
    expect((conn as any).socket).toBeUndefined();
    conn.close();
  }
});
it('ignores a late write error after intentional shutdown', async () => {
  const { conn, socket } = setup();
  const errors: Error[] = [];
  conn.on('error', error => errors.push(error));
  const pending = (conn as any).httpPostOnSocket('/', Buffer.alloc(0)).catch((e: Error) => e.message);
  const callback = socket.write.mock.calls[0][1];
  conn.close();
  callback(new Error('ECANCELED'));
  expect(await pending).toMatch(/closed/i);
  expect(errors).toEqual([]);
});
it.each(['event', 'data'])('handles synchronous %s acknowledgment failures as transport errors', (channel) => {
  for (const failure of ['encrypt', 'write']) {
    const { conn, socket } = setup();
    conn.on('error', () => {});
    const data = channel === 'event' ? Buffer.from('POST / RTSP/1.0\r\nContent-Length: 0\r\n\r\n') : Buffer.alloc(32);
    if (channel === 'data') { data.writeUInt32BE(32); data.write('sync', 4); }
    (conn as any)[`${channel}Session`] = {
      decryptAvailable: () => ({ plaintext: data, rest: Buffer.alloc(0) }),
      encrypt: (bytes: Buffer) => { if (failure === 'encrypt') throw new Error('ack failed'); return bytes; },
    };
    (conn as any)[`${channel}Socket`] = socket;
    socket.write.mockImplementation(() => { throw new Error('ack failed'); });
    expect(() => (conn as any)[channel === 'event' ? 'onEventChannelData' : 'onDataChannelData'](data)).not.toThrow();
    expect((conn as any).socket).toBeUndefined();
  }
});
it('ignores buffered data delivered after close', () => {
  const { conn } = setup();
  const errors: Error[] = [];
  conn.on('error', error => errors.push(error));
  conn.close();
  (conn as any).onDataChannelData(Buffer.from('late'));
  expect(errors).toEqual([]);
});
it('old HTTP write callbacks cannot close a new session on the same instance', async () => {
  const { conn, socket } = setup();
  const pending = (conn as any).httpPostOnSocket('/', Buffer.alloc(0)).catch(() => {});
  const callback = socket.write.mock.calls[0][1];
  conn.close();
  await pending;
  const replacement = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn() });
  (conn as any).closed = false;
  (conn as any).socket = replacement;
  callback(new Error('old write failed'));
  expect((conn as any).socket).toBe(replacement);
  conn.close();
});

it('does not deliver an async decode from a closed transport to replacement waiters', async () => {
  const { conn } = setup();
  const message = await MRPMessage.decode(Buffer.from([8, 4]));
  let finish!: (value: Awaited<ReturnType<typeof MRPMessage.decode>>) => void;
  vi.spyOn(MRPMessage, 'decode').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const observed = vi.fn();
  conn.on('mrp-message', observed);
  const decoding = (conn as any).handleMRPResponse(Buffer.alloc(0));
  conn.close();
  (conn as any).closed = false;
  const resolve = vi.fn();
  (conn as any).pendingMRPResolvers.push({ type: 4, resolve });
  finish(message);
  await decoding;
  expect(observed).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  (conn as any).pendingMRPResolvers = [];
});
it('propagates user listener exceptions instead of mislabeling them decode failures', async () => {
  const { conn } = setup();
  conn.on('mrp-message', () => { throw new Error('listener failed'); });
  await expect((conn as any).handleMRPResponse(await MRPMessage.sendCommand(MessageType.GenericMessage))).rejects.toThrow('listener failed');
  conn.close();
});

it('settles the matching waiter even when a message listener throws', async () => {
  const { conn } = setup();
  const resolve = vi.fn();
  (conn as any).pendingMRPResolvers.push({ type: MessageType.GenericMessage, resolve });
  conn.on('mrp-message', () => { throw new Error('listener failed'); });
  await expect((conn as any).handleMRPResponse(await MRPMessage.sendCommand(MessageType.GenericMessage))).rejects.toThrow('listener failed');
  expect(resolve).toHaveBeenCalledOnce();
  conn.close();
});
it('surfaces async listener failures as exceptions rather than unhandled rejections', async () => {
  const { conn } = setup();
  const error = new Error('listener failed');
  vi.spyOn(conn as any, 'handleMRPResponse').mockRejectedValue(error);
  const schedule = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {});
  const { buildDataStreamFrame } = await import('../util/data-stream.js');
  (conn as any).dataSession = { decryptAvailable: () => ({ plaintext: buildDataStreamFrame(Buffer.from([8, 4])), rest: Buffer.alloc(0) }), encrypt: () => Buffer.alloc(0) };
  (conn as any).onDataChannelData(Buffer.from('frame'));
  await Promise.resolve();
  expect(schedule).toHaveBeenCalledOnce();
  expect(schedule.mock.calls[0][0]).toThrow('listener failed');
  conn.close();
});

it.each(['raw', 'rtsp', 'event'])('rejects oversized HTTP framing on the %s channel before buffering its body', channel => {
  const { conn } = setup();
  const errors: Error[] = []; conn.on('error', error => errors.push(error));
  const data = Buffer.from('RTSP/1.0 200 OK\r\nContent-Length: 16777217\r\n\r\n');
  if (channel === 'raw') (conn as any).onRawData(data);
  if (channel === 'rtsp') (conn as any).onEncryptedData(data);
  if (channel === 'event') {
    (conn as any).eventSession = { decryptAvailable: () => ({ plaintext: data, rest: Buffer.alloc(0) }) };
    (conn as any).onEventChannelData(data);
  }
  try { expect(errors[0]?.message).toMatch(/size limit/i); expect((conn as any).socket).toBeUndefined(); }
  finally { conn.close(); }
});
it('rejects unbounded headers and advertised DataStream lengths', () => {
  for (const channel of ['raw', 'data']) {
    const { conn, socket } = setup(); const errors: Error[] = []; conn.on('error', error => errors.push(error));
    if (channel === 'raw') (conn as any).onRawData(Buffer.alloc(65537, 65));
    else {
      (conn as any).dataSocket = socket;
      (conn as any).dataSession = { decryptAvailable: (data: Buffer) => ({ plaintext: data, rest: Buffer.alloc(0) }) };
      const data = Buffer.alloc(32); data.writeUInt32BE(16777217);
      (conn as any).onDataChannelData(data);
    }
    try { expect(errors[0]?.message).toMatch(/size limit/i); }
    finally { conn.close(); }
  }
});
