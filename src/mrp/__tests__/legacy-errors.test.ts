/** Legacy socket failures must reject pairing, not become unhandled EventEmitter errors. */
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import * as transport from '../../connection.js';
import { LegacyMRPConnection } from '../legacy-connection.js';
import { encodeVarint } from '../../util/data-stream.js';
const credentials = { clientId: 'test', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32), serverId: 'peer' };
it('rejects pairing on a socket reset without requiring an error listener', async () => {
  const socket = new EventEmitter() as EventEmitter & { write: (data: Buffer, callback: (error?: Error) => void) => void; destroy: () => void };
  socket.destroy = vi.fn();
  socket.write = (_data, callback) => { socket.emit('error', new Error('peer reset')); callback(); };
  const connect = vi.spyOn(transport, 'connectSocket').mockResolvedValue(socket as unknown as Socket);
  try {
    await expect(new LegacyMRPConnection('fd00::1', 1234, credentials).startPairing()).rejects.toThrow('peer reset');
    expect(socket.destroy).toHaveBeenCalled();
  } finally { connect.mockRestore(); }
});
it('rejects oversized frames while waiting for DeviceInfo', async () => {
  const socket = new EventEmitter() as EventEmitter & { write: (data: Buffer, callback: (error?: Error) => void) => void; destroy: () => void };
  socket.destroy = vi.fn();
  socket.write = (_data, callback) => { socket.emit('data', encodeVarint(16 * 1024 * 1024 + 1)); callback(); };
  const connect = vi.spyOn(transport, 'connectSocket').mockResolvedValue(socket as unknown as Socket);
  try {
    await expect(new LegacyMRPConnection('fd00::1', 1234, credentials).startPairing()).rejects.toThrow('MRP frame too large');
  } finally { connect.mockRestore(); }
});
it('cancels standalone TCP setup and destroys a late socket after close', async () => {
  let finish!: (socket: Socket) => void;
  const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  socket.write = vi.fn(); socket.destroy = vi.fn();
  const connect = vi.spyOn(transport, 'connectSocket').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const pending = connection.connect();
  const assertion = expect(pending).rejects.toThrow(/closed/);
  connection.close(); finish(socket as unknown as Socket);
  try { await assertion; expect(socket.destroy).toHaveBeenCalledOnce(); expect(socket.write).not.toHaveBeenCalled(); }
  finally { connection.close(); connect.mockRestore(); }
});
it('rejects overlapping standalone connection attempts before opening a second socket', async () => {
  let finish!: (socket: Socket) => void;
  const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  socket.write = vi.fn(); socket.destroy = vi.fn();
  const connect = vi.spyOn(transport, 'connectSocket').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const first = connection.connect().catch(error => error);
  try {
    const second = connection.connect().catch(error => error);
    expect(connect).toHaveBeenCalledOnce();
    expect(await second).toBeInstanceOf(Error);
  } finally { connection.close(); finish(socket as unknown as Socket); await first; connect.mockRestore(); }
});
it('rejects a pending standalone socket write on close', async () => {
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  socket.write = vi.fn(); socket.destroy = vi.fn();
  (connection as unknown as { socket: Socket }).socket = socket as unknown as Socket;
  const sent = connection.sendMRPMessage(Buffer.from([1]));
  const assertion = expect(sent).rejects.toThrow(/closed/);
  connection.close(); await assertion;
});
it('resets standalone encryption and ignores stale socket events after reopening', async () => {
  const first = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  const second = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  first.destroy = vi.fn(); second.destroy = vi.fn();
  const connect = vi.spyOn(transport, 'connectSocket').mockResolvedValueOnce(first as unknown as Socket).mockResolvedValueOnce(second as unknown as Socket);
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const state = connection as unknown as { open(): Promise<void>; outputKey?: Buffer; inCounter: bigint; socket?: Socket; closed: boolean };
  try {
    await state.open(); state.outputKey = Buffer.alloc(32); state.inCounter = 3n;
    connection.close(); await state.open(); first.emit('close');
    expect(state.closed).toBe(false); expect(state.socket).toBe(second); expect(state.outputKey).toBeUndefined(); expect(state.inCounter).toBe(0n);
  } finally { connection.close(); connect.mockRestore(); }
});
it('does not install derived standalone keys after close during verification', async () => {
  const { PairVerify } = await import('../../auth/pair-verify.js');
  let finish!: (keys: { sharedSecret: Buffer; inputKey: Buffer; outputKey: Buffer }) => void;
  const verify = vi.spyOn(PairVerify.prototype, 'verify').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const state = connection as unknown as { authenticateMRP(): Promise<void>; outputKey?: Buffer };
  const pending = state.authenticateMRP();
  connection.close(); finish({ sharedSecret: Buffer.alloc(32), inputKey: Buffer.alloc(32), outputKey: Buffer.alloc(32) });
  try { await expect(pending).rejects.toThrow(/closed/); expect(state.outputKey).toBeUndefined(); }
  finally { verify.mockRestore(); }
});
it('keeps listener exceptions uncaught while settling the standalone waiter', async () => {
  const { MRPMessage } = await import('../messages.js');
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const socket = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  socket.write = vi.fn((_bytes: Buffer, callback: () => void) => callback()); socket.destroy = vi.fn();
  (connection as unknown as { socket: Socket }).socket = socket as unknown as Socket;
  const data = await MRPMessage.sendCommand(42);
  const response = connection.sendMRPMessageAndWait(data, 42);
  await Promise.resolve();
  connection.on('mrp-message', () => { throw new Error('listener failed'); });
  const uncaught: (() => void)[] = [];
  const microtask = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { uncaught.push(callback); });
  const state = connection as unknown as { buffer: Buffer; receive(): Promise<void>; closed: boolean };
  state.buffer = Buffer.concat([encodeVarint(data.length), data]);
  try {
    await state.receive(); await response;
    expect(state.closed).toBe(false); expect(uncaught).toHaveLength(1); expect(uncaught[0]).toThrow('listener failed');
  } finally { connection.close(); microtask.mockRestore(); }
});
it('does not let an old receive continuation consume a reopened session buffer', async () => {
  const { MRPMessage } = await import('../messages.js');
  const connection = new LegacyMRPConnection('fd00::1', 1234, credentials);
  let release!: () => void;
  const state = connection as unknown as { closed: boolean; buffer: Buffer; receive(): Promise<void>; handleMRPResponse(data: Buffer): Promise<void> };
  const handler = vi.spyOn(state, 'handleMRPResponse').mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue();
  const message = await MRPMessage.sendCommand(42);
  state.buffer = Buffer.concat([encodeVarint(message.length), message]);
  const old = state.receive();
  connection.close(); state.closed = false;
  state.buffer = Buffer.concat([encodeVarint(message.length), message]);
  release();
  try { await old; expect(handler).toHaveBeenCalledOnce(); expect(state.buffer.length).toBeGreaterThan(0); }
  finally { connection.close(); handler.mockRestore(); }
});
