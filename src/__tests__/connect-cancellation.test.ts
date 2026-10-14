/** Offline TCP cancellation, concurrent setup, and reusable connection regressions. */
import { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { AirPlayConnection } from '../connection.js';
import { CompanionConnection } from '../companion/connection.js';
const credentials = { clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it.each([['AirPlay', AirPlayConnection], ['Companion', CompanionConnection]] as const)('%s rejects overlapping TCP setup and cancels pending connect promptly', async (_name, Connection) => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) { sockets.push(this); return this; });
  const conn = new Connection('offline', 7000, credentials);
  const first = conn.connect().catch(e => e.message);
  let duplicate: string | undefined;
  void conn.connect().catch(e => { duplicate = e.message; });
  await vi.advanceTimersByTimeAsync(0);
  conn.close();
  let cancellation: string | undefined;
  void first.then(message => { cancellation = message; });
  await vi.advanceTimersByTimeAsync(0);
  // Clean up even against the old implementation before checking its failures.
  for (const socket of sockets) socket.destroy(new Error('test cleanup'));
  await vi.advanceTimersByTimeAsync(0);
  expect(duplicate).toMatch(/already connected/i);
  expect(cancellation).toMatch(/closed/i);
  expect(sockets).toHaveLength(1);
  expect(sockets.every(socket => socket.destroyed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([['AirPlay', AirPlayConnection], ['Companion', CompanionConnection]] as const)('%s can connect again after canceled setup settles', async (_name, Connection) => {
  vi.useFakeTimers();
  const callbacks: Array<() => void> = [];
  const sockets: Socket[] = [];
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket, ...args: unknown[]) {
    sockets.push(this); callbacks.push(args[2] as () => void); return this;
  });
  const conn = new Connection('offline', 7000, credentials);
  // Pair verification is irrelevant to TCP ownership; run production connect/close around it.
  vi.spyOn(conn as any, Connection === AirPlayConnection ? 'pairVerifyOnSocket' : 'pairVerify').mockImplementation(async () => {
    conn.close(); throw new Error('verification stopped');
  });
  const first = conn.connect().catch(e => e.message);
  conn.close();
  callbacks[0]();
  await first;
  const second = conn.connect().catch(e => e.message);
  callbacks[1]?.();
  expect(await second).toBe('verification stopped');
  expect(sockets).toHaveLength(2);
  expect(sockets.every(socket => socket.destroyed)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
