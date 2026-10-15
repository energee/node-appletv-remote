/** Loopback-only receiver tests: no devices, discovery, or credentials involved. */
import { createServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createPublicKey, generateKeyPairSync, diffieHellman, createHash, createDecipheriv, verify } from 'node:crypto';
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ sockets: [] as import('node:dgram').Socket[] }));
const controlledClock = vi.hoisted(() => ({ now: undefined as number | undefined }));
// Virtualize only paced sender delays; loopback sockets and request timeouts stay real.
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: async <T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    if (controlledClock.now === undefined || !options?.signal) return actual.setTimeout(milliseconds, value, options);
    options.signal.throwIfAborted();
    controlledClock.now += milliseconds ?? 1;
    await vi.advanceTimersByTimeAsync(milliseconds ?? 1);
    await actual.setImmediate();
    options.signal.throwIfAborted();
    return value;
  } };
});
// Observe actual local sockets without replacing UDP transport behavior.
vi.mock('node:dgram', async importOriginal => {
  const actual = await importOriginal<typeof import('node:dgram')>();
  return { ...actual, createSocket: (...args: Parameters<typeof actual.createSocket>) => {
    const socket = actual.createSocket(...args); observed.sockets.push(socket); return socket;
  } };
});

// Spy on the shared TCP setup helper while keeping its real behavior.
const connectSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../../connection.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../connection.js')>();
  return { ...actual, connectSocket: (...args: Parameters<typeof actual.connectSocket>) => { connectSpy.calls.push(args); return actual.connectSocket(...args); } };
});

/** Drive paced completion independently of host scheduling while retaining real socket I/O. */
function useControlledClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  controlledClock.now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => controlledClock.now!);
}

const load = () => import('../stream.js');
const receivers: { close(): Promise<void> }[] = [];
afterEach(async () => { controlledClock.now = undefined; vi.useRealTimers(); vi.restoreAllMocks(); for (const item of receivers.splice(0)) await item.close(); });

/** Poll real loopback I/O without vi.waitFor advancing the fake periodic clock. */
async function waitForIo(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (check()) return; await delay(1); }
  throw new Error('Loopback condition did not arrive');
}

async function receiver(mode = 'normal') {
  const audio = createSocket('udp4'); const control = createSocket('udp4'); const timing = createSocket('udp4');
  for (const socket of [audio, control, timing]) { socket.bind(0, '127.0.0.1'); await once(socket, 'listening'); }
  const requests: { method: string; uri: string; requestLine: string; headers: Record<string, string>; body: Buffer }[] = [];
  const packets: Buffer[] = []; const sync: Buffer[] = []; const resends: Buffer[] = []; const timingReplies: Buffer[] = [];
  const clients = new Set<Socket>();
  let localControl = 0; let localTiming = 0;
  const server = createServer(socket => {
    clients.add(socket); socket.on('close', () => clients.delete(socket));
    let input = Buffer.alloc(0); let authenticated = false;
    let clientCurve: Buffer | undefined; let clientSigning: Buffer | undefined;
    const receiverCurve = generateKeyPairSync('x25519');
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      while (true) {
        const end = input.indexOf('\r\n\r\n'); if (end < 0) break;
        const lines = input.subarray(0, end).toString().split('\r\n');
        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) { const split = line.indexOf(':'); headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim(); }
        const length = Number(headers['content-length'] ?? 0); if (input.length < end + 4 + length) break;
        const method = lines[0].split(' ')[0]; const body = Buffer.from(input.subarray(end + 4, end + 4 + length));
        const uri = lines[0].split(' ')[1];
        input = input.subarray(end + 4 + length); requests.push({ method, uri, requestLine: lines[0], headers, body });
        if (mode.startsWith('legacy') && uri === '/pair-verify' &&
          (lines[0] !== 'POST /pair-verify HTTP/1.1' || headers['user-agent'] !== 'AirPlay/320.20' || headers.cseq !== undefined)) {
          socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); continue;
        }
        if (mode === 'legacy-fixture' && uri === '/pair-verify') {
          // Independent public test vectors from pinned pyatv tests/fake_device/airplay.py.
          const first = '01000000891bae9f581f68f9c9933c4f713fbb5b9de639ec7df5d0a4fd4f342f1c21aa6a5e9d1e843302d6265b8c48dd169e273460e567916b0b36280ac071001118f6b2';
          const second = '00000000a1f91acf64aacb185684080b817103b423816ad63b7f5e001f62337b4cc4b3b92c1474959930b7c2a59d0004814300580459d06fc6cc6441bd82bac72a5c5cc7';
          const accepted = body.toString('hex') === first || body.toString('hex') === second;
          const response = body.toString('hex') === first ? Buffer.from('3221371da9f00d035955caa912455fd2acee68117b557f25e39168746af4b631cfab7b2c6d0b58e96cc10af884f5a4cdef8063858a9d9c04e866743cf4b77b4be50de1352ab4ff2691a1a7afd8c1341475b4170ac50455973b7fcf3c24324fa9', 'hex') : Buffer.alloc(0);
          authenticated = body.toString('hex') === second;
          socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 ${accepted ? '200 OK' : '403 Forbidden'}\r\nContent-Length: ${response.length}\r\n\r\n`), response])); continue;
        }
        if (mode.startsWith('legacy') && uri === '/pair-verify') {
          if (mode === 'legacy-hang') continue;
          let response = Buffer.alloc(0);
          if (body[0] === 1 && body.length === 68) {
            clientCurve = body.subarray(4, 36); clientSigning = body.subarray(36);
            response = Buffer.concat([receiverCurve.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), Buffer.alloc(64, 0xab)]);
            if (mode === 'legacy-short') response = Buffer.alloc(31);
          } else if (clientCurve && clientSigning && body.length === 68 && body.subarray(0, 4).equals(Buffer.alloc(4))) {
            const shared = diffieHellman({ privateKey: receiverCurve.privateKey, publicKey: createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), clientCurve]) }) });
            const key = createHash('sha512').update('Pair-Verify-AES-Key').update(shared).digest().subarray(0, 16);
            const iv = createHash('sha512').update('Pair-Verify-AES-IV').update(shared).digest().subarray(0, 16);
            const cipher = createDecipheriv('aes-128-ctr', key, iv); cipher.update(Buffer.alloc(64));
            const signature = cipher.update(body.subarray(4));
            const publicKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), clientSigning]) });
            authenticated = verify(null, Buffer.concat([clientCurve, receiverCurve.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]), publicKey, signature);
          }
          const status = mode === 'legacy-reject' || (body[0] === 0 && !authenticated) ? '403 Forbidden' : '200 OK';
          socket.write(Buffer.concat([Buffer.from(`${mode === 'legacy-wrong-protocol' ? 'RTSP/1.0' : 'HTTP/1.1'} ${status}\r\nContent-Length: ${response.length}\r\n\r\n`), response])); continue;
        }
        if (mode.startsWith('legacy') && !authenticated) { socket.write(`RTSP/1.0 401 Unauthorized\r\nCSeq: ${headers.cseq}\r\nContent-Length: 0\r\n\r\n`); continue; }
        if (uri === '/feedback' && requests.filter(r => r.uri === '/feedback').length > 1) {
          if (mode === 'hold-feedback') continue;
          if (mode === 'timeout-feedback' && requests.filter(r => r.uri === '/feedback').length === 2) continue;
          if (mode === 'disconnect-feedback') { socket.destroy(); continue; }
        }
        if (mode === 'max-body' && method === 'ANNOUNCE') {
          socket.write(Buffer.concat([Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: ${headers.cseq}\r\nContent-Length: 65536\r\n\r\n`), Buffer.alloc(65536)])); continue;
        }
        if (mode === 'hang' && method === 'ANNOUNCE') continue;
        if (mode === 'late' && method === 'RECORD') { setTimeout(() => socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${headers.cseq}\r\nContent-Length: 0\r\n\r\n`), 50); continue; }
        if (mode === 'late' && method === 'TEARDOWN') { setTimeout(() => socket.write(`RTSP/1.0 200 OK\r\nCSeq: ${headers.cseq}\r\nContent-Length: 0\r\n\r\n`), 70); continue; }
        if (mode === 'disconnect' && method === 'RECORD') { socket.destroy(); continue; }
        const status = mode === 'auth' ? '401 Unauthorized' : mode === 'no-feedback' && uri === '/feedback' ? '501 Not Implemented' : '200 OK';
        let extra = '';
        if (method === 'SETUP') {
          localControl = Number(/control_port=(\d+)/.exec(headers.transport)![1]);
          extra = `Session: test-session\r\nTransport: RTP/AVP/UDP;unicast;mode=record;server_port=${audio.address().port};control_port=${control.address().port};timing_port=${timing.address().port}\r\n`;
          if (mode === 'invalid-session') extra = extra.replace('test-session', 'invalid session');
          if (mode === 'wrong-transport') extra = extra.replace('RTP/AVP/UDP', 'RTP/AVP/TCP');
          if (mode === 'bad-port') extra = 'Session: test-session\r\nTransport: RTP/AVP/UDP;server_port=0;control_port=1\r\n';
          if (mode === 'no-timing-port') extra = extra.replace(/;timing_port=\d+/, '');
          if (mode === 'zero-timing-port') extra = extra.replace(/;timing_port=\d+/, ';timing_port=0');
          localTiming = Number(/timing_port=(\d+)/.exec(headers.transport)![1]);

        }
        if (method === 'RECORD') {
          const request = Buffer.alloc(32); request[0] = 0x80; request[1] = 0xd2; request.writeUInt32BE(0x12345678, 24);
          timing.send(request, localTiming, '127.0.0.1');
        }
        if (method === 'RECORD' && mode === 'latency') extra = 'Audio-Latency: 1000\r\n';
        if (mode === 'duplicate') extra += `CSeq: ${headers.cseq}\r\n`;
        if (mode === 'chunked') extra += 'Transfer-Encoding: chunked\r\n';
        socket.write(`RTSP/1.0 ${status}\r\nCSeq: ${headers.cseq}\r\n${extra}Content-Length: 0\r\n\r\n`);
      }
    });
  });
  audio.on('message', packet => {
    packets.push(packet);
    if (packets.length === 1) {
      const request = Buffer.from([0x80, 0xd5, 0, 1, packet[2], packet[3], 0, 1]);
      control.send(request, localControl, '127.0.0.1');
    }
  });
  control.on('message', packet => { if (packet[1] === 0xd6) resends.push(packet); else sync.push(packet); });
  timing.on('message', packet => timingReplies.push(packet));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const result = {
    port: (server.address() as { port: number }).port, requests, packets, sync, resends, timingReplies, clients, timing, get localTiming() { return localTiming; },
    async close() { for (const socket of clients) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); for (const socket of [audio, control, timing]) socket.close(); },
  };
  receivers.push(result); return result;
}
const txt = { cn: '0', et: '0', sr: '44100', ss: '16', ch: '2', tp: 'UDP', pw: 'false', md: '0' };

describe('legacy RAOP streaming', () => {
  it('negotiates L16, emits paced audio and latency tail, timing/resends, metadata and volume, then tears down', async () => {
    const module = await load(); expect(module?.RaopStream).toBeTypeOf('function');
    const peer = await receiver();
    const stream = new module!.RaopStream('127.0.0.1', peer.port, txt);
    useControlledClock();
    await stream.stream(Buffer.from('01000200', 'hex'), { metadata: { title: 'Track', artist: 'Artist', album: 'Album' }, volume: 50 });
    await waitForIo(() => peer.packets.length === 189 && peer.resends.length > 0 && peer.timingReplies.length > 0);
    expect(peer.requests.map(r => r.method)).toEqual(['ANNOUNCE', 'SETUP', 'RECORD', 'FLUSH', 'SET_PARAMETER', 'SET_PARAMETER', 'POST', 'TEARDOWN']);
    expect(peer.requests[6].uri).toBe('/feedback');
    expect(peer.requests[0].body.toString()).toContain('a=rtpmap:96 L16/44100/2\r\n');
    expect(peer.requests[0].body.toString()).toContain('a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n');
    expect(peer.requests[4].body.toString()).toBe('volume: -15\r\n');
    expect(peer.requests[5].headers['content-type']).toBe('application/x-dmap-tagged');
    expect(peer.requests[5].body.toString('hex')).toBe('6d6c6974000000286d696e6d00000005547261636b6173616c00000005416c62756d6173617200000006417274697374');
    expect(peer.packets.length).toBe(189);
    expect(peer.packets[0].subarray(12, 16).toString('hex')).toBe('00010002');
    expect(peer.packets[1].subarray(12).every(byte => byte === 0)).toBe(true);
    expect(peer.packets[1].readUInt32BE(4) - peer.packets[0].readUInt32BE(4)).toBe(352);
    expect(peer.sync.length).toBeGreaterThanOrEqual(2);
    expect(peer.timingReplies[0].subarray(8, 12).toString('hex')).toBe('12345678');
    expect(peer.resends[0].subarray(4)).toEqual(peer.packets[0]);
    expect(peer.requests.at(-1)!.headers.session).toBe('test-session');
  }, 5000);

  it('opens the RTSP control connection through the shared cancellable connectSocket helper', async () => {
    const module = await load(); const peer = await receiver(); connectSpy.calls.length = 0;
    useControlledClock();
    await new module.RaopStream('127.0.0.1', peer.port, txt).stream(Buffer.alloc(4));
    expect(connectSpy.calls).toHaveLength(1);
    expect(connectSpy.calls[0].slice(0, 3)).toEqual(['127.0.0.1', peer.port, 5000]);
    expect(connectSpy.calls[0][3]).toBeInstanceOf(AbortSignal);
  }, 5000);

  it('defaults a missing SETUP timing_port to 0 and answers receiver timing from any port', async () => {
    const module = await load(); const peer = await receiver('no-timing-port');
    useControlledClock();
    await new module.RaopStream('127.0.0.1', peer.port, txt).stream(Buffer.alloc(4));
    await waitForIo(() => peer.packets.length === 189 && peer.timingReplies.length > 0);
    expect(peer.timingReplies[0].subarray(8, 12).toString('hex')).toBe('12345678');
    expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
  }, 5000);

  it('accepts an explicit SETUP timing_port=0 like an omitted one', async () => {
    const module = await load(); const peer = await receiver('zero-timing-port');
    useControlledClock();
    await new module.RaopStream('127.0.0.1', peer.port, txt).stream(Buffer.alloc(4));
    await waitForIo(() => peer.packets.length === 189 && peer.timingReplies.length > 0);
    expect(peer.timingReplies[0].subarray(8, 12).toString('hex')).toBe('12345678');
  }, 5000);

  it('binds the selected interface and pins timing peer without following wall-clock steps', async () => {
    const module = await load(); const peer = await receiver();
    const rogue = createSocket('udp4'); rogue.bind(0, '127.0.0.1'); await once(rogue, 'listening');
    const rogueReplies: Buffer[] = []; rogue.on('message', packet => rogueReplies.push(packet));
    const controller = new AbortController();
    const stream = new module.RaopStream('127.0.0.1', peer.port, txt);
    const playing = stream.stream(Buffer.alloc(44100 * 4), { signal: controller.signal });
    const settled = playing.catch(error => error);
    try {
      await vi.waitFor(() => expect(peer.sync.length).toBeGreaterThan(0));
      expect(observed.sockets.slice(-3).map(socket => socket.address().address)).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1']);
      const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3600000);
      const request = Buffer.alloc(32); request[0] = 0x80; request[1] = 0xd2; request.writeUInt32BE(0xabcdef01, 24);
      rogue.send(request, peer.localTiming, '127.0.0.1');
      peer.timing.send(request, peer.localTiming, '127.0.0.1');
      await vi.waitFor(() => expect(peer.timingReplies.some(packet => packet.readUInt32BE(8) === 0xabcdef01)).toBe(true));
      const reply = peer.timingReplies.find(packet => packet.readUInt32BE(8) === 0xabcdef01)!;
      expect(Math.abs(reply.readUInt32BE(16) - peer.sync[0].readUInt32BE(8))).toBeLessThanOrEqual(1);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(rogueReplies).toEqual([]);
    } finally { vi.restoreAllMocks(); controller.abort(); await settled; rogue.close(); }
  });

  it('sends stable sender identity headers and decimal volume during active updates', async () => {
    const module = await load(); const peer = await receiver();
    const controller = new AbortController();
    const stream = new module.RaopStream('127.0.0.1', peer.port, txt);
    const playing = stream.stream(Buffer.alloc(44100 * 4), { signal: controller.signal });
    const settled = playing.catch(error => error);
    await new Promise<void>(resolve => { const check = setInterval(() => { if (peer.packets.length) { clearInterval(check); resolve(); } }, 2); });
    try {
      await stream.setVolume(0); await stream.setVolume(100); await stream.setVolume(57);
      await stream.setMetadata({ title: '\u00e9' });
      expect(peer.requests.filter(r => r.headers['content-type'] === 'text/parameters').map(r => r.body.toString())).toEqual(['volume: -144\r\n', 'volume: 0\r\n', 'volume: -12.9\r\n']);
      expect(peer.requests.at(-1)!.body.toString('hex')).toBe('6d6c69740000000a6d696e6d00000002c3a9');
      expect(peer.requests[0].headers['dacp-id']).toMatch(/^[0-9A-F]{16}$/);
      expect(peer.requests.every(r => r.headers['client-instance'] === peer.requests[0].headers['dacp-id'])).toBe(true);
      expect(peer.requests[0].headers['active-remote']).toMatch(/^\d+$/);
    } finally { controller.abort(); await settled; }
    await expect(stream.stream(Buffer.alloc(4))).rejects.toThrow(/one-shot/);
    await expect(stream.setMetadata({ title: 'x' })).rejects.toThrow(/active/);
  });

  it('cancels paced streaming promptly and does not send later packets', async () => {
    const module = await load(); expect(module?.RaopStream).toBeTypeOf('function');
    const peer = await receiver(); const controller = new AbortController();
    const stream = new module!.RaopStream('127.0.0.1', peer.port, txt);
    const playing = stream.stream(Buffer.alloc(44100 * 4), { signal: controller.signal });
    await new Promise<void>(resolve => { const check = setInterval(() => { if (peer.packets.length) { clearInterval(check); resolve(); } }, 2); });
    controller.abort(); await expect(playing).rejects.toThrow(/abort/i);
    const count = peer.packets.length;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(peer.packets).toHaveLength(count);
    expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
    await expect(stream.setVolume(50)).rejects.toThrow(/active/i);
  });

  it('discards an abandoned RECORD reply while completing teardown', async () => {
    const module = await load(); const peer = await receiver('late'); const controller = new AbortController();
    const stream = new module.RaopStream('127.0.0.1', peer.port, txt);
    const playing = stream.stream(Buffer.alloc(4), { signal: controller.signal });
    const settled = playing.catch(error => error);
    await new Promise<void>(resolve => { const check = setInterval(() => { if (peer.requests.some(r => r.method === 'RECORD')) { clearInterval(check); resolve(); } }, 2); });
    controller.abort(); const start = performance.now(); await settled;
    expect(performance.now() - start).toBeGreaterThan(50);
    expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
  });

  for (const mode of ['auth', 'bad-port', 'disconnect', 'hang', 'invalid-session', 'wrong-transport', 'latency', 'duplicate', 'chunked']) {
    it(`rejects ${mode} negotiation and releases the TCP connection`, async () => {
      const module = await load(); expect(module?.RaopStream).toBeTypeOf('function');
      const peer = await receiver(mode); const controller = new AbortController();
      const stream = new module!.RaopStream('127.0.0.1', peer.port, txt);
      const playing = stream.stream(Buffer.alloc(4), { signal: controller.signal });
      if (mode === 'hang') setTimeout(() => controller.abort(), 30);
      await expect(playing).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(peer.clients.size).toBe(0); expect(peer.packets).toHaveLength(0);
    });
  }

  it('reframes a Readable across sample and packet boundaries without copying the entire source', async () => {
    const module = await load(); const peer = await receiver();
    const pcm = Buffer.alloc(1412); pcm.writeInt16LE(1, 0); pcm.writeInt16LE(-2, 2); pcm.writeInt16LE(3, 1408);
    const source = Readable.from([pcm.subarray(0, 1), pcm.subarray(1, 1409), pcm.subarray(1409)], { objectMode: false });
    useControlledClock();
    await new module.RaopStream('127.0.0.1', peer.port, txt).stream(source);
    await waitForIo(() => peer.packets.length === 190);
    expect(peer.packets).toHaveLength(190);
    expect(peer.packets[0].subarray(12, 16).toString('hex')).toBe('0001fffe');
    expect(peer.packets[1].subarray(12, 16).toString('hex')).toBe('00030000');
    expect(peer.packets[1].subarray(16).every(byte => byte === 0)).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it('reads coalesced Readable buffers in bounded pieces rather than rejecting valid PCM', async () => {
    const module = await load(); const peer = await receiver();
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(40000, 1)); source.push(Buffer.alloc(40000, 2)); source.push(null);
    useControlledClock();
    await new module.RaopStream('127.0.0.1', peer.port, txt).stream(source);
    await waitForIo(() => peer.packets.length === 245);
    expect(peer.packets).toHaveLength(245);
    const payload = Buffer.concat(peer.packets.slice(0, 57).map(packet => packet.subarray(12)));
    expect(payload.subarray(0, 40000).every(byte => byte === 1)).toBe(true);
    expect(payload.subarray(40000, 80000).every(byte => byte === 2)).toBe(true);
    expect(payload.subarray(80000).every(byte => byte === 0)).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it('accepts the full bounded RTSP body independently from its header length', async () => {
    const module = await load(); const peer = await receiver('max-body'); const cancellation = new AbortController();
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(Buffer.alloc(44100 * 4), { signal: cancellation.signal });
    const settled = playing.catch(error => error);
    try { await waitForIo(() => peer.packets.length > 0); }
    finally { cancellation.abort(); await settled; }
    expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
  });

  it('captures receiver metadata capabilities instead of following later caller mutations', async () => {
    const module = await load(); const peer = await receiver(); const properties = { ...txt, md: '1' };
    const sender = new module.RaopStream('127.0.0.1', peer.port, properties); properties.md = '0';
    await expect(sender.stream(Buffer.alloc(4), { metadata: { title: 'not supported' } })).rejects.toThrow(/metadata/);
  });

  it('accepts text metadata when md lists 0 with surrounding spaces (md=1, 0)', async () => {
    const module = await load(); const peer = await receiver();
    useControlledClock();
    await new module.RaopStream('127.0.0.1', peer.port, { ...txt, md: '1, 0' }).stream(Buffer.alloc(4), { metadata: { title: 'x' } });
    expect(peer.requests.some(r => r.headers['content-type'] === 'application/x-dmap-tagged')).toBe(true);
  }, 5000);

  it('pulls only the current bounded chunk and returns the iterator when cancelled', async () => {
    const module = await load(); const peer = await receiver(); const cancellation = new AbortController();
    let pulls = 0; let returns = 0;
    const source = { [Symbol.asyncIterator]() { return {
      async next() { pulls++; return { done: false, value: Buffer.alloc(65536) }; },
      async return() { returns++; return { done: true as const, value: undefined }; },
    }; } };
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
    const settled = playing.catch(error => error);
    try {
      await vi.waitFor(() => expect(peer.packets.length).toBeGreaterThan(0));
      expect(pulls).toBe(1);
    } finally { cancellation.abort(); await settled; }
    expect(returns).toBe(1);
    const count = peer.packets.length; await turn(); expect(peer.packets).toHaveLength(count);
  });

  it('cancels a pending source read without waiting for an uncooperative iterator return', async () => {
    const module = await load(); const peer = await receiver(); const cancellation = new AbortController();
    let pulls = 0; let returns = 0; let release!: (value: IteratorResult<Buffer>) => void;
    const source = { [Symbol.asyncIterator]() { return {
      next() { if (++pulls === 1) return Promise.resolve({ done: false, value: Buffer.alloc(1408) }); return new Promise<IteratorResult<Buffer>>(resolve => { release = resolve; }); },
      return() { returns++; return new Promise<IteratorResult<Buffer>>(() => {}); },
    }; } };
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
    const settled = playing.catch(error => error);
    await vi.waitFor(() => expect(pulls).toBe(2));
    cancellation.abort(); expect(await settled).toBeInstanceOf(Error); expect(returns).toBe(1);
    release({ done: false, value: Buffer.alloc(1408) }); await turn();
    expect(peer.packets).toHaveLength(1); expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
  });

  it('destroys an owned Readable on negotiation failure', async () => {
    const module = await load(); const peer = await receiver('auth'); const source = new Readable({ read() {} });
    source.push(Buffer.alloc(1408));
    await expect(new module.RaopStream('127.0.0.1', peer.port, txt).stream(source)).rejects.toThrow(/401/);
    expect(source.destroyed).toBe(true);
  });

  it('re-anchors pacing after a source stall instead of aborting the stream', async () => {
    const module = await load(); const peer = await receiver();
    const packet = Buffer.alloc(1408);
    async function* source() {
      for (let i = 0; i < 4; i++) yield packet;
      await new Promise(resolve => setTimeout(resolve, 300));
      for (let i = 0; i < 4; i++) yield packet;
    }
    await expect(new module.RaopStream('127.0.0.1', peer.port, txt).stream(source() as AsyncIterable<Buffer>)).resolves.toBeUndefined();
    expect(peer.packets.length).toBeGreaterThanOrEqual(8);
    // The post-stall resync restates the RTP timestamp it resumes from.
    expect(peer.sync.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  for (const [name, chunks, error] of [
    ['empty', [], /non-empty/], ['partial frame', [Buffer.alloc(3)], /complete/],
    ['non-buffer', ['text'], /Buffer/], ['oversized chunk', [Buffer.alloc(65537)], /65536/],
  ] as const) {
    it(`rejects ${name} streamed PCM and closes its owned iterator`, async () => {
      const module = await load(); const peer = await receiver(); let closed = false;
      async function* source() { try { yield* chunks; } finally { closed = true; } }
      await expect(new module.RaopStream('127.0.0.1', peer.port, txt).stream(source() as AsyncIterable<Buffer>)).rejects.toThrow(error);
      expect(closed).toBe(true); expect(peer.packets).toHaveLength(0);
    });
  }

  for (const mode of ['normal', 'no-feedback']) {
    it(`uses the legacy 25-second feedback interval only after a successful probe (${mode})`, async () => {
      const module = await load(); const peer = await receiver(mode); const cancellation = new AbortController();
      // Only fake the periodic timer. Audio pacing and socket I/O keep real clocks.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const source = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(1408); await new Promise(() => {}); } };
      const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
      const settled = playing.catch(error => error);
      try {
        await waitForIo(() => peer.packets.length > 0);
        expect(peer.requests.filter(r => r.uri === '/feedback')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(24999); await turn();
        expect(peer.requests.filter(r => r.uri === '/feedback')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        if (mode === 'normal') await waitForIo(() => peer.requests.filter(r => r.uri === '/feedback').length === 2);
        else { await turn(); expect(peer.requests.filter(r => r.uri === '/feedback')).toHaveLength(1); }
        expect(peer.requests.filter(r => r.uri === '/feedback').every(r => r.method === 'POST' && r.body.length === 0)).toBe(true);
      } finally { cancellation.abort(); await settled; }
      const count = peer.requests.length; await vi.advanceTimersByTimeAsync(50000); await turn();
      expect(peer.requests).toHaveLength(count); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
    });
  }

  for (const mode of ['hold-feedback', 'disconnect-feedback']) {
    it(`keeps feedback bounded and releases a pending source after ${mode}`, async () => {
      const module = await load(); const peer = await receiver(mode); const cancellation = new AbortController();
      let returned = false;
      const source = { [Symbol.asyncIterator]() { let first = true; return {
        next() { if (first) { first = false; return Promise.resolve({ done: false, value: Buffer.alloc(1408) }); } return new Promise<IteratorResult<Buffer>>(() => {}); },
        async return() { returned = true; return { done: true as const, value: undefined }; },
      }; } };
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
      const settled = playing.catch(error => error);
      try {
        await waitForIo(() => peer.packets.length > 0); await vi.advanceTimersByTimeAsync(25000);
        await waitForIo(() => peer.requests.filter(r => r.uri === '/feedback').length === 2);
        if (mode === 'hold-feedback') {
          await vi.advanceTimersByTimeAsync(100000); await turn();
          expect(peer.requests.filter(r => r.uri === '/feedback')).toHaveLength(2);
          cancellation.abort();
        }
        expect(await settled).toBeInstanceOf(Error); expect(returned).toBe(true);
        if (mode === 'hold-feedback') expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
        expect(vi.getTimerCount()).toBe(0);
      } finally { cancellation.abort(); await settled; vi.useRealTimers(); }
    });
  }

  it('logs a timed-out periodic feedback request and keeps streaming', async () => {
    const module = await load(); const peer = await receiver('timeout-feedback'); const cancellation = new AbortController();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const source = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(1408); await new Promise(() => {}); } };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
    let settled = false; const result = playing.catch(error => error).finally(() => { settled = true; });
    try {
      await waitForIo(() => peer.packets.length > 0); await vi.advanceTimersByTimeAsync(25000);
      await waitForIo(() => peer.requests.filter(r => r.uri === '/feedback').length === 2);
      // The real 5-second request timeout elapses; the stream must survive it.
      await delay(5200);
      expect(settled).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/\[RAOP\].*feedback.*timeout/i));
      await vi.advanceTimersByTimeAsync(25000);
      await waitForIo(() => peer.requests.filter(r => r.uri === '/feedback').length === 3);
      expect(settled).toBe(false);
    } finally { cancellation.abort(); await result; vi.useRealTimers(); }
  }, 10000);

  it('streams a finite source past the legacy keepalive deadline with bounded pulls', async () => {
    const module = await load(); const peer = await receiver(); let produced = 0;
    const bytes = 26 * 44100 * 4;
    async function* source() {
      while (produced < bytes) {
        const length = Math.min(65536, bytes - produced); produced += length;
        yield Buffer.alloc(length);
      }
    }
    useControlledClock();
    try {
      await new module.RaopStream('127.0.0.1', peer.port, txt).stream(source());
      await waitForIo(() => peer.packets.length === 3446);
      expect(produced).toBe(bytes);
      expect(peer.packets).toHaveLength(3446);
      expect(peer.requests.filter(r => r.uri === '/feedback')).toHaveLength(2);
      expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
      expect(peer.sync.length).toBeGreaterThanOrEqual(27);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controlledClock.now = undefined; vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 15000);

  it('verifies legacy PIN credentials on the same socket before cleartext L16 setup', async () => {
    const module = await load(); const peer = await receiver('legacy'); const cancellation = new AbortController();
    const stream = new module.RaopStream('127.0.0.1', peer.port, { ...txt, sf: '0x200' });
    const playing = stream.stream(Buffer.alloc(44100 * 4), { signal: cancellation.signal, legacySeed: Buffer.alloc(32, 1) });
    const settled = playing.catch(error => error);
    try {
      await waitForIo(() => peer.packets.length > 0);
      expect(peer.requests.slice(0, 3).map(r => [r.method, r.uri])).toEqual([['POST', '/pair-verify'], ['POST', '/pair-verify'], ['ANNOUNCE', peer.requests[2].uri]]);
      expect(peer.requests[0].body.subarray(0, 4).toString('hex')).toBe('01000000');
      expect(peer.requests[0].body).toHaveLength(68); expect(peer.requests[1].body).toHaveLength(68);
      expect(peer.requests[0].headers['content-type']).toBe('application/octet-stream');
      for (const request of peer.requests.slice(0, 2)) {
        expect(request.requestLine).toBe('POST /pair-verify HTTP/1.1');
        expect(request.headers['user-agent']).toBe('AirPlay/320.20');
        expect(request.headers.connection).toBe('keep-alive');
        expect(request.headers.cseq).toBeUndefined();
        expect(request.headers['dacp-id']).toBeUndefined();
      }
      expect(peer.requests[2].requestLine).toBe(`ANNOUNCE ${peer.requests[2].uri} RTSP/1.0`);
      expect(peer.requests[2].headers.cseq).toBe('1');
      expect(peer.requests[2].headers['user-agent']).toBe('AirPlay/550.10');
      expect(peer.clients.size).toBe(1);
    } finally { cancellation.abort(); await settled; }
  });

  it('matches the pinned upstream legacy verification byte vectors', async () => {
    const module = await load(); const peer = await receiver('legacy-fixture'); const cancellation = new AbortController();
    const seed = Buffer.from('8f06696f2542d70df59286c761695c485f815be3d152849e1361282d46ab1493', 'hex');
    const sender = new module.RaopStream('127.0.0.1', peer.port, { ...txt, sf: '0x200' });
    const playing = sender.stream(Buffer.alloc(44100 * 4), { signal: cancellation.signal, legacySeed: seed });
    const settled = playing.catch(error => error);
    try { await waitForIo(() => peer.packets.length > 0); expect(peer.requests[2].method).toBe('ANNOUNCE'); }
    finally { cancellation.abort(); await settled; }
    expect(seed.toString('hex')).toBe('8f06696f2542d70df59286c761695c485f815be3d152849e1361282d46ab1493');
  });

  it('rejects an unpaired legacy seed against the independent upstream receiver vectors', async () => {
    const module = await load(); const peer = await receiver('legacy-fixture');
    const sender = new module.RaopStream('127.0.0.1', peer.port, { ...txt, sf: '0x200' });
    await expect(sender.stream(Buffer.alloc(4), { legacySeed: Buffer.alloc(32) })).rejects.toThrow(/403/);
    await waitForIo(() => peer.clients.size === 0);
    expect(peer.packets).toHaveLength(0); expect(peer.requests).toHaveLength(1);
  });

  for (const mode of ['legacy-short', 'legacy-reject', 'legacy-hang', 'legacy-wrong-protocol']) {
    it(`releases the owned source and connection after ${mode} verification`, async () => {
      const module = await load(); const peer = await receiver(mode); const cancellation = new AbortController();
      const source = Readable.from([Buffer.alloc(1408), Buffer.alloc(65536)], { objectMode: false });
      const stream = new module.RaopStream('127.0.0.1', peer.port, { ...txt, sf: '0x200' });
      const playing = stream.stream(source, { signal: cancellation.signal, legacySeed: Buffer.alloc(32, 1) });
      const rejected = expect(playing).rejects.toThrow();
      if (mode === 'legacy-hang') { await waitForIo(() => peer.requests.length > 0); cancellation.abort(); }
      await rejected; await waitForIo(() => peer.clients.size === 0);
      expect(source.destroyed).toBe(true); expect(peer.packets).toHaveLength(0);
      expect(peer.requests.every(r => r.uri === '/pair-verify')).toBe(true);
    });
  }

  it('requires legacy material for PIN flags and refuses modern audio/auth advertisements', async () => {
    const module = await load();
    const sender = new module.RaopStream('127.0.0.1', 7000, { ...txt, sf: '0x200' });
    await expect(sender.stream(Buffer.alloc(4))).rejects.toThrow(/legacy/);
    await expect(sender.stream(Buffer.alloc(4), { legacySeed: Buffer.alloc(31) })).rejects.toThrow(/32/);
    for (const properties of [{ ...txt, sf: '0x80' }, { ...txt, sf: 'nonsense' }, { ...txt, ft: '0x0,0x10000' }, { ...txt, ft: '0x0,0x100' }, { ...txt, et: '4' }]) {
      expect(() => new module.RaopStream('127.0.0.1', 7000, properties)).toThrow(/unsupported/i);
    }
    expect(() => new module.RaopStream('127.0.0.1', 7000, { ...txt, sf: '0x4' })).not.toThrow();
  });

  it('does not start a queued producer read after synchronous cancellation', async () => {
    const module = await load(); const peer = await receiver(); const cancellation = new AbortController();
    let reads = 0; let returned = false;
    const source = { [Symbol.asyncIterator]() { return {
      async next() { reads++; return { done: false, value: Buffer.alloc(1408) }; },
      async return() { returned = true; return { done: true as const, value: undefined }; },
    }; } };
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
    cancellation.abort(); await expect(playing).rejects.toThrow(/abort/i); await turn();
    expect(reads).toBe(0); expect(returned).toBe(true); expect(peer.requests).toHaveLength(0);
  });

  it('propagates source errors and tears down after audio has begun', async () => {
    const module = await load(); const peer = await receiver(); let closed = false;
    async function* source() { try { yield Buffer.alloc(1408); throw new Error('producer failed'); } finally { closed = true; } }
    await expect(new module.RaopStream('127.0.0.1', peer.port, txt).stream(source())).rejects.toThrow('producer failed');
    await waitForIo(() => peer.packets.length === 1);
    expect(closed).toBe(true); expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
  });

  it('cancels a pending Readable read and releases its source before setup', async () => {
    const module = await load(); const peer = await receiver(); const source = new Readable({ read() {} });
    const cancellation = new AbortController();
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(source, { signal: cancellation.signal });
    const rejected = expect(playing).rejects.toThrow(/abort/i);
    await turn(); cancellation.abort(); await rejected; await turn();
    // Node's async iterator retains its own error observer after destruction.
    expect(source.destroyed).toBe(true); expect(source.closed).toBe(true);
    expect(peer.requests).toHaveLength(0);
  });

  it('neither floods nor aborts after a deterministic clock jump', async () => {
    const module = await load(); const peer = await receiver(); const cancellation = new AbortController();
    const playing = new module.RaopStream('127.0.0.1', peer.port, txt).stream(Buffer.alloc(44100 * 4), { signal: cancellation.signal });
    const settled = playing.catch(error => error);
    await waitForIo(() => peer.packets.length > 0);
    const before = peer.packets.length; const syncs = peer.sync.length; let now = performance.now() + 1000;
    // A 1 s jump, then the clock advances one packet per read: catch-up would send ~125 packets at once.
    vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.001));
    try {
      await waitForIo(() => peer.sync.length > syncs);
      await turn();
      expect(peer.packets.length).toBeLessThanOrEqual(before + 3);
    } finally { vi.restoreAllMocks(); cancellation.abort(); }
    expect(await settled).toBeInstanceOf(Error);
    expect(peer.requests.at(-1)!.method).toBe('TEARDOWN');
  });

  it('rejects invalid signals before taking source ownership or consuming the sender', async () => {
    const module = await load(); const peer = await receiver();
    const source = Readable.from([Buffer.alloc(4)]);
    const sender = new module.RaopStream('127.0.0.1', peer.port, txt);
    await expect(sender.stream(source, { signal: {} as AbortSignal, legacySeed: Buffer.alloc(32, 1) }))
      .rejects.toThrow('RAOP signal must be an AbortSignal');
    expect(source.destroyed).toBe(false);
    expect(peer.requests).toHaveLength(0);
    useControlledClock();
    await sender.stream(source);
    expect(source.destroyed).toBe(true);
    expect(peer.requests[0].method).toBe('ANNOUNCE');
  });

  it('fails closed for codec, encryption, authentication, rate, and invalid PCM/volume', async () => {
    const module = await load(); expect(module?.RaopStream).toBeTypeOf('function');
    for (const properties of [{ ...txt, cn: '1' }, { ...txt, et: '1' }, { ...txt, pw: 'true' }, { ...txt, sr: '48000' }, { ...txt, tp: 'TCP' }]) {
      expect(() => new module!.RaopStream('127.0.0.1', 7000, properties)).toThrow(/unsupported/i);
    }
    const stream = new module!.RaopStream('127.0.0.1', 7000, txt);
    const noMetadata = new module.RaopStream('127.0.0.1', 7000, { ...txt, md: '1' });
    await expect(noMetadata.stream(Buffer.alloc(4), { metadata: { title: 'x' } })).rejects.toThrow(/metadata/);
    await expect(stream.stream(Buffer.alloc(4), { metadata: { title: 'x'.repeat(4097) } })).rejects.toThrow(/long/);
    await expect(stream.stream(Buffer.alloc(3))).rejects.toThrow(/PCM/i);
    await expect(stream.stream(Buffer.alloc(4), { volume: NaN })).rejects.toThrow(/volume/i);
    const controller = new AbortController(); controller.abort();
    await expect(stream.stream(Buffer.alloc(4), { signal: controller.signal })).rejects.toThrow(/abort/i);
  });
});
