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
it('rejects identifierless application requests before creating response timers', async () => {
  vi.useFakeTimers();
  const conn = connection();
  const request = Buffer.from(protocol.encode(protocol.create({ type: MessageType.PlaybackQueueRequest })).finish());
  await expect(conn.sendMRPMessageAndWait(request, MessageType.SetState)).rejects.toThrow(/identifier/i);
  expect(vi.getTimerCount()).toBe(0);
  conn.close();
});
