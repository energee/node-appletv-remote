/** Loopback wire tests for authenticated AirPlay 2 URL playback; no device or stored keys. */
import { describe, it, expect, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { generateKeyPairSync, diffieHellman, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import * as api from '../index.js';
import { tlvEncode, tlvDecode, TlvTag } from '../util/tlv.js';
import { encryptChaCha20, decryptChaCha20, hkdfSha512 } from '../util/crypto.js';
import { HAPSession } from '../util/hap-session.js';
import { parseHTTPMessage } from '../connection.js';

const raw = (key: KeyObject) => Buffer.from(key.export({ format: 'der', type: 'spki' }).subarray(-32));
/**
 * bplist-creator writes 8-byte ints (marker 0x13) with the high word zeroed; restore it so values past 2^32
 * are encoded as tvOS (and Python plistlib) encode them. Every integer in `data` must be a distinct value.
 */
const bplist64 = (data: Record<string, unknown>) => {
  const out = bplistCreator(data);
  const ints = JSON.stringify(data).match(/\d{10,}/g)?.map(Number).filter(v => v >= 2 ** 32) ?? [];
  for (const value of ints) {
    const low = Buffer.alloc(4); low.writeUInt32BE(value % 2 ** 32);
    const at = out.indexOf(Buffer.concat([Buffer.from([0x13, 0, 0, 0, 0]), low]));
    if (at >= 0) out.writeUInt32BE(Math.floor(value / 2 ** 32), at + 1);
  }
  return out;
};
const nonce = (label: string) => { const n = Buffer.alloc(12); n.write(label, 4); return n; };

async function receiver(options: { rejectAuth?: boolean; commandCode?: number; info?: Record<string, unknown>; dropStatus?: boolean; holdStatus?: boolean; badCseq?: boolean; emptyM4?: boolean; oversize?: boolean; duplicateLength?: boolean } = {}) {
  const serverKeys = generateKeyPairSync('ed25519');
  const clientKeys = generateKeyPairSync('ed25519');
  const credentials = { clientId: 'synthetic-client', serverId: 'synthetic-server', clientLTPK: raw(clientKeys.publicKey), clientLTSK: Buffer.from(clientKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)), serverLTPK: raw(serverKeys.publicKey) };
  const requests: Array<{ line: string; headers: Record<string, string>; body: Record<string, unknown>; rawBody: Buffer }> = [];
  /** Decoded params.data of each POST /command, in order. */
  const commands: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  let eventConnected = false;
  let eventCipher: HAPSession;
  let eventAcknowledged = false;
  let timingPort = 0;
  let controlClosed = false;
  let eventSocket: Socket | undefined;
  let eventCseq = 100;
  /** Push an event-channel /command whose params.data is a nested bplist, as tvOS 26 does. */
  const push = (data: Record<string, unknown>) => {
    const body = bplistCreator({ params: { data: bplist64(data) } });
    eventSocket!.write(eventCipher.encrypt(Buffer.concat([Buffer.from(`POST /command RTSP/1.0\r\nCSeq: ${++eventCseq}\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: ${body.length}\r\n\r\n`), body])));
  };
  const events = createServer(socket => {
    eventSocket = socket;
    // A client close can reset a fake socket (ECONNRESET on Linux); a real peer just drops it.
    eventConnected = true; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => { buffer = Buffer.concat([buffer, data]); const decoded = eventCipher.decryptAvailable(buffer); buffer = Buffer.from(decoded.rest); if (decoded.plaintext.length) { expect(decoded.plaintext.toString()).toContain('RTSP/1.0 200 OK'); if (decoded.plaintext.includes('CSeq: 73')) eventAcknowledged = true; } });
    socket.write(eventCipher.encrypt(Buffer.from('POST /event RTSP/1.0\r\nCSeq: 73\r\nContent-Length: 0\r\n\r\n')));
  });
  await new Promise<void>(resolve => events.listen(0, '127.0.0.1', resolve));
  const eventPort = (events.address() as { port: number }).port;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); controlClosed = true; });
    socket.on('error', () => {});
    let encrypted = Buffer.alloc(0), plain = Buffer.alloc(0);
    let session: HAPSession | undefined;
    let secret: Buffer, ephemeral: Buffer, clientEphemeral: Buffer;
    socket.on('data', async (data: Buffer) => {
      if (session) {
        encrypted = Buffer.concat([encrypted, data]);
        const decoded = session.decryptAvailable(encrypted);
        encrypted = Buffer.from(decoded.rest);
        plain = Buffer.concat([plain, decoded.plaintext]);
      } else plain = Buffer.concat([plain, data]);
      while (true) {
        const end = plain.indexOf('\r\n\r\n');
        if (end < 0) return;
        const lines = plain.subarray(0, end).toString().split('\r\n');
        const headers = Object.fromEntries(lines.slice(1).map(line => { const p = line.indexOf(':'); return [line.slice(0, p).toLowerCase(), line.slice(p + 1).trim()]; }));
        const length = Number(headers['content-length'] ?? 0);
        if (plain.length < end + 4 + length) return;
        const body = plain.subarray(end + 4, end + 4 + length);
        plain = Buffer.from(plain.subarray(end + 4 + length));
        const [method, path, protocol] = lines[0].split(' ');
        const reply = (payload: Buffer = Buffer.alloc(0), code = 200) => {
          const message = Buffer.concat([Buffer.from(`${protocol} ${code} OK\r\nCSeq: ${options.badCseq && session ? 999 : headers.cseq ?? 0}\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: ${payload.length}\r\n\r\n`), payload]);
          const wire = session ? session.encrypt(message) : message;
          // Split responses to exercise streaming buffers rather than packet assumptions.
          socket.write(wire.subarray(0, 5)); socket.write(wire.subarray(5));
        };
        if (path === '/pair-verify') {
          const tlv = tlvDecode(body);
          if (options.rejectAuth) { reply(tlvEncode({ [TlvTag.Error]: Buffer.from([2]) }), 403); continue; }
          if (tlv[TlvTag.SeqNo]![0] === 1) {
            const keys = generateKeyPairSync('x25519');
            ephemeral = raw(keys.publicKey); clientEphemeral = tlv[TlvTag.PublicKey]!;
            secret = diffieHellman({ privateKey: keys.privateKey, publicKey: createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), clientEphemeral]) }) });
            const key = await hkdfSha512(secret, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', 32);
            const signature = sign(null, Buffer.concat([ephemeral, Buffer.from(credentials.serverId), clientEphemeral]), serverKeys.privateKey);
            const enc = encryptChaCha20(key, nonce('PV-Msg02'), tlvEncode({ [TlvTag.Identifier]: Buffer.from(credentials.serverId), [TlvTag.Signature]: signature }), Buffer.alloc(0));
            reply(tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.PublicKey]: ephemeral, [TlvTag.EncryptedData]: Buffer.concat([enc.ciphertext, enc.tag]) }));
          } else {
            const key = await hkdfSha512(secret!, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', 32);
            const enc = tlv[TlvTag.EncryptedData]!;
            const proof = tlvDecode(decryptChaCha20(key, nonce('PV-Msg03'), enc.subarray(0, -16), enc.subarray(-16), Buffer.alloc(0)));
            expect(verify(null, Buffer.concat([clientEphemeral!, proof[TlvTag.Identifier]!, ephemeral!]), clientKeys.publicKey, proof[TlvTag.Signature]!)).toBe(true);
            const verifiedSession = new HAPSession(await hkdfSha512(secret!, 'Control-Salt', 'Control-Read-Encryption-Key', 32), await hkdfSha512(secret!, 'Control-Salt', 'Control-Write-Encryption-Key', 32));
            eventCipher = new HAPSession(await hkdfSha512(secret!, 'Events-Salt', 'Events-Write-Encryption-Key', 32), await hkdfSha512(secret!, 'Events-Salt', 'Events-Read-Encryption-Key', 32));
            reply(options.emptyM4 ? Buffer.alloc(0) : tlvEncode({ [TlvTag.SeqNo]: Buffer.from([4]) }));
            session = verifiedSession;
          }
          continue;
        }
        requests.push({ line: lines[0], headers, rawBody: Buffer.from(body), body: body.length ? parseBuffer(body)[0] as Record<string, unknown> : {} });
        const request = requests.at(-1)!.body;
        if (method === 'SETUP' && request.streams) reply(bplistCreator({ streams: [{ type: 130, streamID: 1 }] }));
        else if (method === 'SETUP') { timingPort = request.timingPort as number; reply(bplistCreator({ eventPort })); }
        else if (path === '/command' && (options.oversize || options.duplicateLength)) {
          socket.write(session!.encrypt(Buffer.from(options.oversize ? 'HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n' : 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncontent-length: 999999999\r\n\r\n')));
        } else if (path === '/command') {
          const command = parseBuffer((request.params as { data: Buffer }).data)[0] as Record<string, unknown>;
          commands.push(command);
          reply(Buffer.alloc(0), options.commandCode ?? 200);
          if (command.type === 'setRate' && !options.holdStatus) push({ type: 'playbackState', name: 'playing' });
          if (command.type === 'playbackInfo' && !options.holdStatus) {
            if (options.dropStatus) eventSocket!.destroy();
            else push({ kind: 'response', messageID: command.messageID, info: options.info ?? { playbackState: 'playing', rate: 1, duration: { flags: 1, value: 120000, timescale: 1000, epoch: 0 }, position: { flags: 1, value: 6_711_083_000, timescale: 1_000_000_000, epoch: 0 } } });
          }
        } else if (path === '/play' || path === '/playback-info') reply(Buffer.alloc(0), 500); // tvOS 18+
        else reply();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { credentials, port: (server.address() as { port: number }).port, requests, commands, push, get eventConnected() { return eventConnected; }, get eventAcknowledged() { return eventAcknowledged; }, get timingPort() { return timingPort; }, get controlClosed() { return controlClosed; }, async close() { for (const s of sockets) s.destroy(); await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => events.close(() => r()))]); } };
}

const Playback = api.AirPlayPlaybackSession;

describe('AirPlay URL playback', () => {
  it('cancels a pending timing bind when closing', async () => {
    const fake = await receiver(); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      const binding = (playback as unknown as { openTiming(address: string): Promise<void> }).openTiming('127.0.0.1');
      const result = binding.then(() => 'resolved', () => 'rejected');
      playback.close();
      expect(await Promise.race([result, new Promise(r => setTimeout(() => r('hung'), 100))])).toBe('rejected');
    } finally { playback.close(); await fake.close(); }
  });
  it('preserves strict malformed-length rejection in the shared parser', () => {
    expect(() => parseHTTPMessage(Buffer.from('RTSP/1.0 200 OK\r\nContent-Length: abc\r\n\r\n'))).toThrow('Invalid Content-Length');
  });
  it('encodes the setRate rate as a plist real', async () => {
    const fake = await receiver(); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      await playback.playUrl('https://example.org/movie.mp4');
      const setRate = fake.requests.filter(r => r.line === 'POST /command HTTP/1.1')[2].body.params as { data: Buffer };
      expect(setRate.data.includes(Buffer.from('233ff0000000000000', 'hex'))).toBe(true);
    } finally { playback.close(); await fake.close(); }
  });
  it.each([{ badCseq: true }, { emptyM4: true }])('rejects malformed authentication or RTSP correlation: %j', async options => {
    const fake = await receiver(options); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4')).rejects.toThrow(/CSeq|M4/); }
    finally { playback.close(); await fake.close(); }
  });
  it('rejects an oversized response before buffering its body', async () => {
    const fake = await receiver({ oversize: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4')).rejects.toThrow(/large|limit/); }
    finally { playback.close(); await fake.close(); }
  }, 10000);
  it('keeps playback alive with feedback and stops feedback after close', async () => {
    const fake = await receiver(); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    const feedback = () => fake.requests.filter(r => r.line === 'POST /feedback RTSP/1.0').length;
    // Only the 2 s heartbeat interval is faked; sockets and request timeouts keep real clocks.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await playback.playUrl('https://example.org/movie.mp4');
      expect(feedback()).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(feedback()).toBe(2));
      playback.close();
      await vi.advanceTimersByTimeAsync(4000);
      await new Promise(r => setTimeout(r, 20));
      expect(feedback()).toBe(2);
    } finally { vi.useRealTimers(); playback.close(); await fake.close(); }
  }, 10000);
  it('times out an unanswered receiver request and tears down', async () => {
    const fake = await receiver({ holdStatus: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/Timeout/); await expect(playback.getStatus()).rejects.toThrow(/Timeout/); }
    finally { playback.close(); await fake.close(); }
  }, 10000);
  it('rejects duplicate Content-Length before parser last-header handling', async () => {
    const fake = await receiver({ duplicateLength: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4')).rejects.toThrow(/Duplicate/); }
    finally { playback.close(); await fake.close(); }
  }, 10000);
  it('exports a dedicated playback session', () => expect(Playback).toBeTypeOf('function'));
  it('authenticates, queues the URL over the tvOS 26 remote-control stream and reads status from events', async () => {
    const fake = await receiver();
    const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      await playback.playUrl('https://example.org/movie.mp4');
      expect(fake.eventConnected).toBe(true);
      const [setup, stream] = fake.requests.filter(r => r.line.startsWith('SETUP'));
      expect(setup.body.timingProtocol).toBe('NTP');
      expect(setup.body.timingPort).toBeGreaterThan(0);
      expect(setup.body.isRemoteControlOnly).toBeUndefined();
      expect(stream.body.streams).toEqual([expect.objectContaining({ type: 130, controlType: 1 })]);
      expect(fake.requests.findIndex(r => r.line.startsWith('RECORD'))).toBeLessThan(fake.requests.indexOf(stream));
      expect(fake.requests.some(r => r.line.startsWith('POST /play ') || r.line.startsWith('GET /playback-info'))).toBe(false);
      const command = fake.requests.find(r => r.line === 'POST /command HTTP/1.1')!;
      expect(command.headers['x-apple-streamid']).toBe('1');
      expect(command.headers['x-apple-session-id']).toMatch(/^[A-F0-9-]{36}$/);
      expect(fake.commands.map(c => c.type)).toEqual(['insertPlayQueueItem', 'setProperty', 'setRate']);
      expect(fake.commands[0].item).toMatchObject({ mediaType: 'file', 'Content-Location': 'https://example.org/movie.mp4' });
      // 6.7e9 ns is an 8-byte bplist int (as tvOS sends past ~4.3 s); it must not wrap to 32 bits.
      expect(await playback.getStatus()).toEqual({ state: 'playing', duration: 120, position: 6.711083, rate: 1 });
      expect(fake.commands.at(-1)).toMatchObject({ type: 'playbackInfo', kind: 'request' });
      expect(fake.eventAcknowledged).toBe(true);
      const udp = createSocket('udp4');
      try {
        const replies: Buffer[] = []; udp.on('message', packet => replies.push(packet));
        // 32-byte packets that are not RTP timing requests (type 0x52 or 0xd2) get no reply.
        const ignored = Buffer.alloc(32); ignored[0] = 0x80; ignored[1] = 0xd3; ignored.writeUInt32BE(999, 24);
        udp.send(ignored, fake.timingPort, '127.0.0.1');
        await new Promise(r => setTimeout(r, 30));
        expect(replies).toEqual([]);
        const request = Buffer.alloc(32); request[0] = 0x80; request[1] = 0xd2; request.writeUInt32BE(123, 24);
        const response = new Promise<Buffer>((resolve, reject) => { udp.once('message', resolve); udp.once('error', reject); });
        udp.send(request, fake.timingPort, '127.0.0.1');
        const packet = await response;
        expect(packet[1]).toBe(0xd3); expect(packet.readUInt16BE(2)).toBe(7); expect(packet.readUInt32BE(8)).toBe(123); expect(packet.readUInt32BE(24)).toBeGreaterThan(2208988800);
      } finally { udp.close(); }
      playback.close(); playback.close();
    } finally { playback.close(); await fake.close(); }
  });
  it.each([{ rejectAuth: true }, { commandCode: 500 }])('rejects receiver failures and closes its socket: %j', async options => {
    const fake = await receiver(options); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4')).rejects.toThrow(/403|500/); await new Promise(r => setTimeout(r, 10)); expect(fake.controlClosed).toBe(true); }
    finally { playback.close(); await fake.close(); }
  });
  it('reports receiver playback errors and releases the session', async () => {
    const fake = await receiver({ info: { error: { code: 42, domain: 'MediaError' } } }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/42.*MediaError/); }
    finally { playback.close(); await fake.close(); }
  });
  it('rejects connection loss instead of reporting successful playback', async () => {
    const fake = await receiver({ dropStatus: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/closed|lost/); }
    finally { playback.close(); await fake.close(); }
  });

  it('close rejects both an in-flight and queued status request', async () => {
    const fake = await receiver({ holdStatus: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      await playback.playUrl('https://example.org/movie.mp4');
      const first = expect(playback.getStatus()).rejects.toThrow(/closed/);
      const second = expect(playback.getStatus()).rejects.toThrow(/closed/);
      await new Promise(r => setTimeout(r, 10)); playback.close();
      await Promise.all([first, second]);
    } finally { playback.close(); await fake.close(); }
  });
  it('rejects a nonzero start position before connecting (tvOS 26 ignores it)', async () => {
    const fake = await receiver(); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4', 12.5)).rejects.toThrow(/start position/i); expect(fake.requests).toHaveLength(0); }
    finally { playback.close(); await fake.close(); }
  });
  it.each(['paused', 'loading', 'stopped'] as const)('reports receiver playbackState %s with rate and no timing', async state => {
    const fake = await receiver({ info: { playbackState: state, rate: 0 } }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); expect(await playback.getStatus()).toEqual({ state, rate: 0 }); }
    finally { playback.close(); await fake.close(); }
  });
  it('reports loading while the queued item is not ready (no playbackState yet, as tvOS sends at startup)', async () => {
    const fake = await receiver({ info: { readyToPlay: false, item: { uuid: 'ITEM' } } }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); expect(await playback.getStatus()).toEqual({ state: 'loading' }); }
    finally { playback.close(); await fake.close(); }
  });
  it('reports a pushed end of playback without polling', async () => {
    const fake = await receiver({ holdStatus: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      await playback.playUrl('https://example.org/movie.mp4');
      fake.push({ type: 'playbackState', name: 'stopped', reason: 'ended' });
      await vi.waitFor(() => expect(playback.state).toBe('stopped'));
    } finally { playback.close(); await fake.close(); }
  });
  it.each(['file:///private/movie.mp4', 'not-a-url'])('rejects unsupported URL before connecting: %s', async url => {
    const fake = await receiver(); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl(url)).rejects.toThrow(/HTTP|URL/); expect(fake.requests).toHaveLength(0); }
    finally { playback.close(); await fake.close(); }
  });
});

it('pins playback timing replies to the TCP peer and negotiated port, ignoring send failures', async () => {
  const playback = new Playback('127.0.0.1', 7000, {} as api.HAPCredentials);
  const state = playback as unknown as { openTiming(address: string): Promise<void>; timing: import('node:dgram').Socket; timingPeer?: { address: string; port?: number }; closed: boolean };
  state.timingPeer = { address: '127.0.0.1', port: 1234 };
  await state.openTiming('127.0.0.1');
  const send = vi.spyOn(state.timing, 'send').mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== 'function') throw new Error('Missing timing send error callback');
    callback(new Error('UDP unreachable'));
  });
  const request = Buffer.alloc(32); request[0] = 0x80; request[1] = 0xd2;
  try {
    state.timing.emit('message', request, { address: '127.0.0.2', port: 1234 });
    state.timing.emit('message', request, { address: '127.0.0.1', port: 1235 });
    expect(send).not.toHaveBeenCalled();
    expect(() => state.timing.emit('message', request, { address: '127.0.0.1', port: 1234 })).not.toThrow();
    expect(send).toHaveBeenCalledOnce(); expect(state.closed).toBe(false);
  } finally { send.mockRestore(); playback.close(); }
});
it.each(['encrypt', 'write'])('cleans a synchronous playback %s failure immediately', async failure => {
  const playback = new Playback('127.0.0.1', 7000, {} as api.HAPCredentials);
  const state = playback as any;
  state.socket = { write: () => { if (failure === 'write') throw new Error('sync failure'); }, destroy: vi.fn() };
  state.cipher = { encrypt: () => { if (failure === 'encrypt') throw new Error('sync failure'); return Buffer.alloc(0); } };
  try {
    await expect(state.request('POST', '/feedback', 'RTSP/1.0')).rejects.toThrow('sync failure');
    expect(state.pending).toBeUndefined(); expect(state.closed).toBe(true);
  } finally { playback.close(); }
});
it('binds IPv6 timing and brackets IPv6 Host and RTSP URI', async () => {
  const playback = new Playback('::1', 7000, {} as api.HAPCredentials);
  const state = playback as any;
  try {
    await state.openTiming('::1');
    expect(state.timing.address().family).toBe('IPv6');
    let sent = '';
    state.socket = { localAddress: 'fe80::2%en0', write: (data: Buffer) => { sent = data.toString(); }, destroy: vi.fn() };
    expect(state.uri).toMatch(/^rtsp:\/\/\[fe80::2%25en0\]\//);
    void state.request('POST', '/feedback', 'RTSP/1.0').catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    expect(sent).toContain('Host: [::1]:7000\r\n');
  } finally { playback.close(); }
});
