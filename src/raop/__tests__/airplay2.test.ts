/** Loopback tests for the AirPlay 2 realtime-audio SETUP sequence (pair-verify, encrypted SETUPs, event channel). */
import { setTimeout as delay } from 'node:timers/promises';
import bplistCreator from 'bplist-creator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RtspClient } from '../stream.js';
import { setupAirPlay2Audio } from '../airplay2.js';
import { PairVerify } from '../../auth/pair-verify.js';
import { HAPSession } from '../../util/hap-session.js';
import { connectSocket } from '../../connection.js';
import { airplay2Receiver, closedPort, until } from './airplay2-receiver.js';

// Record every 32-byte random key (the stream `shk`), so tests can check it is zeroed.
const created = vi.hoisted(() => ({ keys: [] as Buffer[] }));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: ((size: number) => {
    const bytes = actual.randomBytes(size); if (size === 32) created.keys.push(bytes); return bytes;
  }) as typeof actual.randomBytes };
});
const zeroed = (buffer: Buffer) => buffer.every(byte => byte === 0);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  created.keys.length = 0; vi.restoreAllMocks();
});

async function connect(options: Parameters<typeof airplay2Receiver>[0] = {}) {
  const receiver = await airplay2Receiver(options); cleanups.push(() => receiver.close());
  const failures: Error[] = [];
  const client = new RtspClient(await connectSocket('127.0.0.1', receiver.port), error => failures.push(error));
  cleanups.push(() => { client.socket.destroy(); });
  client.setLocalUri(1234567);
  return { receiver, client, failures };
}
const ports = { timing: 50001, control: 50002 };

describe('setupAirPlay2Audio', () => {
  it('verifies, encrypts RTSP, opens the event channel and sends both SETUP bodies', async () => {
    const { receiver, client } = await connect();
    const result = await setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, new AbortController().signal);
    cleanups.push(() => { result.events.destroy(); });

    const verify = receiver.requests.filter(request => request.uri === '/pair-verify');
    expect(verify).toHaveLength(2);
    for (const request of verify) {
      expect(request.startLine).toBe('POST /pair-verify HTTP/1.1');
      expect(request.headers['x-apple-hkp']).toBe('3');
      expect(request.headers.cseq).toBeUndefined();
      expect(request.encrypted).toBe(false);
    }
    const setupRequests = receiver.requests.filter(request => request.method === 'SETUP');
    expect(setupRequests.map(request => [request.startLine, request.encrypted, request.headers['content-type']])).toEqual([
      ['SETUP rtsp://127.0.0.1/1234567 RTSP/1.0', true, 'application/x-apple-binary-plist'],
      ['SETUP rtsp://127.0.0.1/1234567 RTSP/1.0', true, 'application/x-apple-binary-plist'],
    ]);
    // Neither SETUP uses the legacy Transport negotiation.
    expect(setupRequests.every(request => request.headers.transport === undefined)).toBe(true);
    const [base, stream] = receiver.setups();
    expect(base).toMatchObject({ timingProtocol: 'NTP', timingPort: ports.timing });
    expect(base.streams).toBeUndefined();
    const description = (stream.streams as Record<string, unknown>[])[0];
    expect(description).toMatchObject({
      type: 0x60, ct: 1, audioFormat: 0x800, spf: 352, sr: 44100, latencyMin: 11025, latencyMax: 88200,
      controlPort: ports.control, isMedia: true, audioMode: 'default', supportsDynamicStreamID: false, streamConnectionID: 1234567,
    });
    expect(Buffer.isBuffer(description.shk) && description.shk.length).toBe(32);
    expect(result.audioKey).toEqual(description.shk);

    expect(result.serverPort).toBeGreaterThan(0);
    expect(result.controlPort).toBeGreaterThan(0);
    // The event channel was connected after the base SETUP and its request acknowledged.
    await until(() => receiver.state.eventAcknowledged);
    expect(receiver.state.eventAcknowledged).toBe(true);
  });

  it.each([
    ['missing dataPort', { dataPort: undefined }],
    ['zero controlPort', { controlPort: 0 }],
    ['fractional dataPort', { dataPort: 7000.5 }],
    ['out-of-range controlPort', { controlPort: 70000 }],
    ['string dataPort', { dataPort: '7000' }],
  ])('rejects a stream SETUP reply with %s and closes the event channel', async (_name, stream) => {
    const { receiver, client } = await connect({ stream });
    await expect(setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, new AbortController().signal)).rejects.toThrow(/dataPort|controlPort/);
    await until(() => receiver.state.eventClosed);
    expect(receiver.state.eventClosed).toBe(true);
  });

  it('zeroes the pair-verify secret and stream SETUP body at once, and the RTSP session keys when the connection closes', async () => {
    const verify = vi.spyOn(PairVerify.prototype, 'verify');
    const encrypt = vi.spyOn(HAPSession.prototype, 'encrypt');
    const { receiver, client } = await connect();
    const request = vi.spyOn(client, 'request');
    const result = await setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, new AbortController().signal);
    cleanups.push(() => { result.events.destroy(); });
    const keys = await verify.mock.results[0].value as Awaited<ReturnType<PairVerify['verify']>>;
    expect(zeroed(keys.sharedSecret)).toBe(true);
    // The stream SETUP body carried shk in the clear before encryption.
    const setups = request.mock.calls.filter(([method]) => method === 'SETUP').map(([, , body]) => body!);
    expect(setups).toHaveLength(2);
    expect(zeroed(setups[1])).toBe(true);
    // So is every plaintext request the RTSP session encrypted (the wire copy of that body included).
    const cipher = (client as unknown as { cipher: HAPSession }).cipher;
    const plaintexts = encrypt.mock.calls.filter((_, index) => encrypt.mock.contexts[index] === cipher).map(([data]) => data);
    expect(plaintexts).toHaveLength(2);
    expect(plaintexts.every(zeroed)).toBe(true);
    expect(zeroed(result.audioKey)).toBe(false); // The caller zeroes shk after TEARDOWN.
    expect(zeroed(keys.outputKey) || zeroed(keys.inputKey)).toBe(false);
    const closing = new Promise(resolve => client.socket.once('close', resolve));
    client.socket.destroy();
    await closing;
    expect(zeroed(keys.outputKey) && zeroed(keys.inputKey)).toBe(true);
  });

  it('zeroes shk when the stream SETUP reply is rejected', async () => {
    const { receiver, client } = await connect({ stream: { dataPort: 0 } });
    await expect(setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, new AbortController().signal)).rejects.toThrow(/dataPort/);
    expect(created.keys).toHaveLength(1);
    expect(zeroed(created.keys[0])).toBe(true);
  });

  it.each([
    ['is not a binary plist', Buffer.from('not a plist')],
    ['is a plist array', bplistCreator([1, 2])],
  ])('rejects a base SETUP reply that %s before connecting the event channel', async (_name, baseReply) => {
    const { receiver, client } = await connect({ baseReply });
    await expect(setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, new AbortController().signal)).rejects.toThrow('Invalid AirPlay 2 SETUP reply');
    await delay(20);
    expect(receiver.state.eventConnected).toBe(false);
  });

  it('rejects a base SETUP reply without a valid eventPort', async () => {
    const { receiver, client } = await connect({ eventPort: 0 });
    await expect(setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, new AbortController().signal)).rejects.toThrow(/eventPort/);
    expect(receiver.requests.filter(request => request.method === 'SETUP')).toHaveLength(1);
  });

  it('rejects wrong credentials before any SETUP', async () => {
    const { receiver, client } = await connect();
    const wrong = { ...receiver.credentials, serverLTPK: Buffer.from(receiver.credentials.clientLTPK) };
    await expect(setupAirPlay2Audio(client, '127.0.0.1', wrong, 1234567, ports, new AbortController().signal)).rejects.toThrow(/signature/i);
    expect(receiver.requests.some(request => request.method === 'SETUP')).toBe(false);
  });

  it('stops and cleans up when aborted while waiting to retry the event connect', async () => {
    // A port that refuses connections forces the 1 s retry wait.
    const { receiver, client } = await connect({ eventPort: await closedPort() });
    const controller = new AbortController();
    const setup = setupAirPlay2Audio(client, '127.0.0.1', receiver.credentials, 1234567, ports, controller.signal);
    await until(() => receiver.requests.some(request => request.method === 'SETUP'));
    await delay(50);
    const aborted = performance.now();
    controller.abort();
    // Abort must reach the retry wait itself, not just fail after the remaining refused attempts (~4 s).
    await expect(setup).rejects.toThrow('Connection closed during setup');
    expect(performance.now() - aborted).toBeLessThan(500);
    expect(receiver.requests.filter(request => request.method === 'SETUP')).toHaveLength(1);
    expect(receiver.state.eventConnected).toBe(false);
    expect(created.keys).toHaveLength(0); // No stream key was created.
  });
});
