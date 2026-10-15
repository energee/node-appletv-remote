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
const nonce = (label: string) => { const n = Buffer.alloc(12); n.write(label, 4); return n; };

async function receiver(options: { rejectAuth?: boolean; playCode?: number; status?: Record<string, unknown>; dropStatus?: boolean; holdStatus?: boolean; xmlStatus?: boolean; badCseq?: boolean; emptyM4?: boolean; oversize?: boolean; duplicateLength?: boolean } = {}) {
  const serverKeys = generateKeyPairSync('ed25519');
  const clientKeys = generateKeyPairSync('ed25519');
  const credentials = { clientId: 'synthetic-client', serverId: 'synthetic-server', clientLTPK: raw(clientKeys.publicKey), clientLTSK: Buffer.from(clientKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)), serverLTPK: raw(serverKeys.publicKey) };
  const requests: Array<{ line: string; headers: Record<string, string>; body: Record<string, unknown>; rawBody: Buffer }> = [];
  const sockets = new Set<Socket>();
  let eventConnected = false;
  let eventCipher: HAPSession;
  let eventAcknowledged = false;
  let timingPort = 0;
  let controlClosed = false;
  const events = createServer(socket => {
    // A client close can reset a fake socket (ECONNRESET on Linux); a real peer just drops it.
    eventConnected = true; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => { buffer = Buffer.concat([buffer, data]); const decoded = eventCipher.decryptAvailable(buffer); buffer = Buffer.from(decoded.rest); if (decoded.plaintext.length) { expect(decoded.plaintext.toString()).toContain('RTSP/1.0 200 OK'); expect(decoded.plaintext.toString()).toContain('CSeq: 73'); eventAcknowledged = true; } });
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
        if (method === 'SETUP') { timingPort = requests.at(-1)!.body.timingPort as number; reply(bplistCreator({ eventPort })); }
        else if (path === '/play') reply(Buffer.alloc(0), options.playCode ?? 200);
        else if (path === '/playback-info') {
          if (options.duplicateLength) { socket.write(session!.encrypt(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncontent-length: 999999999\r\n\r\n'))); continue; }
          if (options.oversize) { socket.write(session!.encrypt(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n'))); continue; }
          if (options.holdStatus) continue;
          if (options.dropStatus) socket.destroy();
          else if (options.xmlStatus) reply(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>duration</key><real>120</real><key>position</key><real>3</real><key>rate</key><real>1</real></dict></plist>'));
          else reply(bplistCreator(options.status ?? { duration: 120, position: 3, rate: 1 }));
        } else reply();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { credentials, port: (server.address() as { port: number }).port, requests, get eventConnected() { return eventConnected; }, get eventAcknowledged() { return eventAcknowledged; }, get timingPort() { return timingPort; }, get controlClosed() { return controlClosed; }, async close() { for (const s of sockets) s.destroy(); await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => events.close(() => r()))]); } };
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
  it('encodes whole-second position and rate/volume as plist reals', async () => {
    const fake = await receiver(); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      await playback.playUrl('https://example.org/movie.mp4', 0);
      const body = fake.requests.find(r => r.line === 'POST /play HTTP/1.1')!.rawBody;
      expect(body.includes(Buffer.from('230000000000000000', 'hex'))).toBe(true);
      expect(body.includes(Buffer.from('233ff0000000000000', 'hex'))).toBe(true);
    } finally { playback.close(); await fake.close(); }
  });
  it.each([{ badCseq: true }, { emptyM4: true }])('rejects malformed authentication or RTSP correlation: %j', async options => {
    const fake = await receiver(options); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4')).rejects.toThrow(/CSeq|M4/); }
    finally { playback.close(); await fake.close(); }
  });
  it('rejects an oversized response before buffering its body', async () => {
    const fake = await receiver({ oversize: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/large|limit/); }
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
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/Duplicate/); }
    finally { playback.close(); await fake.close(); }
  }, 10000);
  it('exports a dedicated playback session', () => expect(Playback).toBeTypeOf('function'));
  it('authenticates, sets up media (not MRP), plays and reads encrypted status', async () => {
    const fake = await receiver();
    const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try {
      await playback.playUrl('https://example.org/movie.mp4', 12.5);
      expect(fake.eventConnected).toBe(true);
      const setup = fake.requests.find(r => r.line.startsWith('SETUP'))!;
      expect(setup.body.timingProtocol).toBe('NTP');
      expect(setup.body.timingPort).toBeGreaterThan(0);
      expect(setup.body.isRemoteControlOnly).toBeUndefined();
      expect(fake.requests.some(r => r.body.streams)).toBe(false);
      const play = fake.requests.find(r => r.line === 'POST /play HTTP/1.1')!;
      expect(play.body['Content-Location']).toBe('https://example.org/movie.mp4');
      expect(play.body['Start-Position-Seconds']).toBe(12.5);
      expect(play.headers['x-apple-session-id']).toMatch(/^[a-f0-9-]{36}$/);
      expect(fake.requests.some(r => r.line === 'POST /rate?value=1.000000 RTSP/1.0')).toBe(true);
      expect(await playback.getStatus()).toMatchObject({ state: 'playing', duration: 120, position: 3 });
      expect(fake.eventAcknowledged).toBe(true);
      const udp = createSocket('udp4');
      try {
        const request = Buffer.alloc(32); request[0] = 0x80; request.writeUInt32BE(123, 24);
        const response = new Promise<Buffer>((resolve, reject) => { udp.once('message', resolve); udp.once('error', reject); });
        udp.send(request, fake.timingPort, '127.0.0.1');
        const packet = await response;
        expect(packet[1]).toBe(0xd3); expect(packet.readUInt16BE(2)).toBe(7); expect(packet.readUInt32BE(8)).toBe(123); expect(packet.readUInt32BE(24)).toBeGreaterThan(2208988800);
      } finally { udp.close(); }
      playback.close(); playback.close();
    } finally { playback.close(); await fake.close(); }
  });
  it.each([{ rejectAuth: true }, { playCode: 500 }])('rejects receiver failures and closes its socket: %j', async options => {
    const fake = await receiver(options); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await expect(playback.playUrl('https://example.org/movie.mp4')).rejects.toThrow(/403|500/); await new Promise(r => setTimeout(r, 10)); expect(fake.controlClosed).toBe(true); }
    finally { playback.close(); await fake.close(); }
  });
  it('reports receiver playback errors and releases the session', async () => {
    const fake = await receiver({ status: { error: { code: 42, domain: 'MediaError' } } }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/42.*MediaError/); }
    finally { playback.close(); await fake.close(); }
  });
  it('rejects connection loss instead of reporting successful playback', async () => {
    const fake = await receiver({ dropStatus: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); await expect(playback.getStatus()).rejects.toThrow(/closed|lost/); }
    finally { playback.close(); await fake.close(); }
  });

  it('decodes XML playback-info as used by the pinned pyatv receiver', async () => {
    const fake = await receiver({ xmlStatus: true }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); expect(await playback.getStatus()).toMatchObject({ state: 'playing', duration: 120, position: 3 }); }
    finally { playback.close(); await fake.close(); }
  });
  it.each([{ duration: 120, rate: 0 }, {}])('decodes paused and idle receiver state: %j', async status => {
    const fake = await receiver({ status }); const playback = new Playback('127.0.0.1', fake.port, fake.credentials);
    try { await playback.playUrl('https://example.org/movie.mp4'); expect((await playback.getStatus()).state).toBe('duration' in status ? 'paused' : 'idle'); }
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
