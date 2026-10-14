/** Offline Companion pending-frame and transport cleanup regression tests. */
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionConnection } from '../connection.js';
import { FrameType } from '../framing.js';
const credentials = { clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('close rejects pre-authentication frame waiters and clears their timers', async () => {
  vi.useFakeTimers();
  const conn = new CompanionConnection('offline', 7000, credentials);
  let error: Error | undefined;
  void (conn as any).waitForFrame(FrameType.PV_Next).catch((e: Error) => { error = e; });
  conn.close();
  conn.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(error?.message).toMatch(/closed/i);
  expect(vi.getTimerCount()).toBe(0);
});
it('failed pair-verify destroys partial transport and prevents application sends', async () => {
  const conn = new CompanionConnection('offline', 7000, credentials);
  const socket = { destroy: vi.fn() };
  vi.spyOn(conn as any, 'openSocket').mockImplementation(async () => { (conn as any).socket = socket; });
  vi.spyOn(conn as any, 'pairVerify').mockRejectedValue(new Error('verify failed'));
  await expect(conn.connect()).rejects.toThrow('verify failed');
  expect(socket.destroy).toHaveBeenCalledOnce();
  expect(() => conn.sendMessage('test', new Map())).toThrow('not connected');
});
it('write callback failures reject application work and reset the session', async () => {
  vi.useFakeTimers();
  const conn = new CompanionConnection('offline', 7000, credentials);
  (conn as any).session = { encrypt: () => Buffer.from('frame') };
  (conn as any).socket = { write: (_data: Buffer, cb: (err: Error) => void) => cb(new Error('write failed')), destroy() {} };
  await expect(conn.sendRequest('test', new Map())).rejects.toThrow('write failed');
  expect(() => conn.sendMessage('test', new Map())).toThrow('not connected');
  expect(vi.getTimerCount()).toBe(0);
});
it('pair-verify write failure rejects setup promptly instead of leaving a frame timer', async () => {
  vi.useFakeTimers();
  const conn = new CompanionConnection('offline', 7000, credentials);
  vi.spyOn(conn as any, 'openSocket').mockImplementation(async () => {
    (conn as any).socket = { write: (_data: Buffer, cb: (e: Error) => void) => cb(new Error('pair write failed')), destroy() {} };
  });
  let error: Error | undefined;
  void conn.connect().catch(e => { error = e; });
  await vi.advanceTimersByTimeAsync(0);
  expect(error?.message).toBe('pair write failed');
  expect(vi.getTimerCount()).toBe(0);
});
it('ignores late callback errors after deliberate close', () => {
  const conn = new CompanionConnection('offline', 7000, credentials);
  const errors: Error[] = [];
  conn.on('error', error => errors.push(error));
  let callback!: (error: Error) => void;
  (conn as any).socket = { write: (_bytes: Buffer, cb: typeof callback) => { callback = cb; }, destroy() {} };
  (conn as any).writeRaw(Buffer.alloc(0));
  conn.close();
  callback(new Error('ECANCELED'));
  expect(errors).toEqual([]);
});

it('synchronous application write failure throws instead of returning success', () => {
  const conn = new CompanionConnection('offline', 7000, credentials);
  (conn as any).session = { encrypt: () => Buffer.from('frame') };
  (conn as any).socket = { write() { throw new Error('sync write failed'); }, destroy() {} };
  expect(() => conn.sendMessage('test', new Map())).toThrow('sync write failed');
});
