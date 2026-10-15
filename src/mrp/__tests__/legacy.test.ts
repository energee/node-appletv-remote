/** Standalone MRP transport selection and pinned pyatv CryptoPairing regressions. */
import { expect, it, vi } from 'vitest';
import { AppleTV } from '../../appletv.js';
import { Credentials } from '../../credentials.js';
import { MRPMessage, MessageType } from '../messages.js';
import { AirPlayConnection } from '../../connection.js';
import { LegacyMRPConnection } from '../legacy-connection.js';

it('formats IPv6 RTSP session URIs with brackets', () => {
  const conn = new AirPlayConnection('fd00::1', 7000, credentials);
  const state = conn as unknown as { localAddress: string; rtspUri: string };
  state.localAddress = 'fd00::2';
  expect(state.rtspUri.startsWith('rtsp://[fd00::2]/')).toBe(true);
});

it('rejects pending requests when the legacy socket is closed', async () => {
  const conn = new LegacyMRPConnection('fd00::1', 1234, credentials);
  vi.spyOn(conn, 'sendMRPMessage').mockResolvedValue();
  const response = conn.sendMRPMessageAndWait(await MRPMessage.sendCommand(42), 42, 50);
  const assertion = expect(response).rejects.toThrow('closed');
  conn.close();
  await assertion;
});
const credentials = new Credentials({ clientId: 'test', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32), serverId: 'server' });
it('rejects MRP operations on Companion-only devices before opening a socket', async () => {
  const atv = new AppleTV({ name: 'TV', address: 'fd00::1', port: 0, deviceId: 'id', model: 'Unknown', companionPort: 1234 });
  const connect = vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  await expect(atv.connect(credentials)).rejects.toThrow('No MRP transport');
  expect(connect).not.toHaveBeenCalled();
  connect.mockRestore();
  await expect(atv.startPairing()).rejects.toThrow('No MRP transport');
});
it('preserves AirPlay selection when both usable transports advertise', async () => {
  const legacy = vi.spyOn(LegacyMRPConnection.prototype, 'connect').mockResolvedValue();
  const airplay = vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  await new AppleTV({ name: 'TV', address: 'fd00::1', port: 7000, mrpPort: 49152, deviceId: 'id', model: 'AppleTV' }).connect(credentials);
  expect(airplay).toHaveBeenCalledOnce();
  expect(legacy).not.toHaveBeenCalled();
  legacy.mockRestore(); airplay.mockRestore();
});

it('uses state 2 only for the initial standalone pairing request', async () => {
  const start = await MRPMessage.decode(await MRPMessage.cryptoPairing(Buffer.from([0, 1, 0]), true));
  expect((start['.cryptoPairingMessage'] as { state: number }).state).toBe(2);
  expect(Object.hasOwn(start, 'identifier')).toBe(false);
  const verify = await MRPMessage.decode(await MRPMessage.cryptoPairing(Buffer.from([6, 1, 1])));
  expect((verify['.cryptoPairingMessage'] as { state: number }).state).toBe(0);
});

it('heartbeat matches any reply type by identifier and retries one miss before failing (pyatv HEARTBEAT_RETRIES=1)', async () => {
  const conn = new LegacyMRPConnection('fd00::1', 1234, credentials);
  const errors: Error[] = [];
  conn.on('error', error => errors.push(error));
  (conn as any).socket = { destroy: () => {} };
  // Per attempt: reply type, or undefined for no reply.
  const replies: Array<number | undefined> = [MessageType.SetState, undefined, MessageType.GenericMessage, undefined, undefined];
  vi.spyOn(conn, 'sendMRPMessage').mockImplementation(async data => {
    const type = replies.shift();
    const identifier = (await MRPMessage.decode(data)).identifier as string;
    const reply = Buffer.concat([Buffer.from([8, type ?? 0, 0x12, identifier.length]), Buffer.from(identifier)]);
    if (type !== undefined) setImmediate(() => void (conn as any).handleMRPResponse(reply));
  });
  await (conn as any).heartbeatOnce(20);
  await (conn as any).heartbeatOnce(20);
  expect(errors).toEqual([]);
  await (conn as any).heartbeatOnce(20);
  expect(errors.map(e => e.message).join()).toMatch(/Timeout/);
  expect(replies).toEqual([]);
});
