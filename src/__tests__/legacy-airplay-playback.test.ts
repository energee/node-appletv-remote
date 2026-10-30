import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, verify, type Decipheriv } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyAirPlayPlaybackSession } from '../legacy-airplay-playback.js';
import type { LegacyAirPlayCredentials } from '../auth/legacy-pair-setup.js';
import { parseHTTPMessage } from '../connection.js';

const XML_PREFIX = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"\n"http://www.apple.com/DTDs/PropertyList-1.0.dtd">';
const plist = (content: string) => Buffer.from(`${XML_PREFIX}<plist version="1.0"><dict>${content}</dict></plist>`);
const STATUS = plist('<key>duration</key><real>20</real><key>position</key><real>5</real><key>rate</key><real>1</real><key>readyToPlay</key><true/>');
const UPGRADE = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: PTTH/1.0\r\nContent-Length: 0\r\n\r\n');
const MEDIA_URL = 'https://example.test/video.mp4';
function event(state: string): Buffer {
  return eventBody(plist(`<key>category</key><string>video</string><key>sessionID</key><integer>13</integer><key>state</key><string>${state}</string>`));
}
function eventBody(body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`POST /event HTTP/1.1\r\nX-Apple-Session-ID: 00000000-0000-0000-0000-000000000000\r\nContent-Type: application/x-apple-plist\r\nContent-Length: ${body.length}\r\n\r\n`), body]);
}
interface Request { line: string; headers: Record<string, string>; body: Buffer; socket: Socket; }
interface PeerOptions {
  hold?: 'reverse' | 'status' | 'play';
  fragmentedUpgrade?: boolean;
  status?: Buffer;
  rawStatus?: string;
  rejectPlay?: boolean;
  verify?: 'valid' | 'short-reply';
}
class Receiver extends EventEmitter {
  readonly requests: Request[] = [];
  readonly sockets = new Set<Socket>();
  readonly timeline: string[] = [];
  readonly server = createServer(socket => this.accept(socket));
  reverse?: Socket;
  accepted = 0;
  verified = false;
  fault?: unknown;
  private proof?: { decrypt: Decipheriv; clientCurve: Buffer; clientSigning: Buffer; receiverCurve: Buffer };
  constructor(readonly options: PeerOptions) { super(); }
  get port(): number { return (this.server.address() as { port: number }).port; }
  waitFor(match: (request: Request) => boolean, after = 0): Promise<Request> {
    const found = this.requests.slice(after).find(match);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => {
      const received = (request: Request) => {
        if (!match(request)) return;
        this.removeListener('request', received);
        resolve(request);
      };
      this.on('request', received);
    });
  }
  drained(): Promise<void> {
    return this.sockets.size === 0 ? Promise.resolve() : new Promise(resolve => this.once('drained', resolve));
  }
  reply(socket: Socket, body: Buffer = Buffer.alloc(0), status = 200): void {
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 ${status} Response\r\nContent-Length: ${body.length}\r\n\r\n`), body]));
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    if (this.fault) throw new Error('Synthetic receiver failed', { cause: this.fault });
  }
  private accept(socket: Socket): void {
    this.accepted++;
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => {
      this.sockets.delete(socket);
      if (socket === this.reverse) this.timeline.push('reverse-closed');
      if (!this.sockets.size) this.emit('drained');
    });
    let input = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      try {
        input = Buffer.concat([input, chunk]);
        for (;;) {
          const message = parseHTTPMessage(input, 1024 * 1024);
          if (!message) return;
          input = input.subarray(message.totalSize);
          const request = { line: message.startLine, headers: message.headers, body: message.body, socket };
          this.requests.push(request);
          this.respond(request);
          this.emit('request', request);
        }
      } catch (error) { this.fault = error; socket.destroy(); }
    });
  }
  private respond(request: Request): void {
    const { line, socket, body } = request;
    if (line.startsWith('HTTP/')) { this.timeline.push('ack'); return; }
    if (line === 'POST /pair-verify HTTP/1.1') {
      if (this.options.verify === 'short-reply') { this.reply(socket, Buffer.alloc(95)); return; }
      if (!this.proof) {
        assert.equal(body.length, 68);
        assert.deepEqual(body.subarray(0, 4), Buffer.from([1, 0, 0, 0]));
        const receiver = generateKeyPairSync('x25519');
        const receiverCurve = receiver.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
        const clientCurve = body.subarray(4, 36);
        const clientSigning = body.subarray(36);
        const clientKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), clientCurve]), format: 'der', type: 'spki' });
        const shared = diffieHellman({ privateKey: receiver.privateKey, publicKey: clientKey });
        const key = createHash('sha512').update('Pair-Verify-AES-Key').update(shared).digest().subarray(0, 16);
        const iv = createHash('sha512').update('Pair-Verify-AES-IV').update(shared).digest().subarray(0, 16);
        const cipher = createCipheriv('aes-128-ctr', key, iv);
        const receiverProof = Buffer.concat([cipher.update(Buffer.alloc(64)), cipher.final()]);
        const decrypt = createDecipheriv('aes-128-ctr', key, iv);
        decrypt.update(receiverProof);
        this.proof = { decrypt, clientCurve, clientSigning, receiverCurve };
        this.reply(socket, Buffer.concat([receiverCurve, receiverProof]));
      } else {
        assert.equal(body.length, 68);
        assert.deepEqual(body.subarray(0, 4), Buffer.alloc(4));
        const { decrypt, clientCurve, clientSigning, receiverCurve } = this.proof;
        const signingKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), clientSigning]), format: 'der', type: 'spki' });
        const signature = Buffer.concat([decrypt.update(body.subarray(4)), decrypt.final()]);
        this.verified = verify(null, Buffer.concat([clientCurve, receiverCurve]), signingKey, signature);
        this.reply(socket, Buffer.alloc(0), this.verified ? 200 : 403);
      }
      return;
    }
    if (line === 'POST /reverse HTTP/1.1') {
      this.reverse = socket;
      if (this.options.hold === 'reverse') return;
      if (this.options.fragmentedUpgrade) {
        socket.write(UPGRADE.subarray(0, 19));
        setImmediate(() => socket.write(Buffer.concat([UPGRADE.subarray(19), ...['stopped', 'loading', 'playing', 'paused'].map(event)])));
      } else socket.write(UPGRADE);
      return;
    }
    if (line === 'GET /playback-info HTTP/1.1') {
      if (this.options.hold === 'status') return;
      if (this.options.rawStatus) socket.write(this.options.rawStatus);
      else this.reply(socket, this.options.status ?? STATUS);
      return;
    }
    if (line === 'POST /play HTTP/1.1') {
      if (this.options.hold === 'play') return;
      this.reply(socket, Buffer.alloc(0), this.options.rejectPlay ? 401 : 200);
      return;
    }
    throw new Error(`Unexpected client request: ${line}`);
  }
}
const peers: Receiver[] = [];
const sessions: LegacyAirPlayPlaybackSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
  await Promise.all(peers.splice(0).map(peer => peer.close()));
});
async function peer(options: PeerOptions = {}): Promise<Receiver> {
  const receiver = new Receiver(options);
  receiver.server.listen(0, '127.0.0.1');
  await once(receiver.server, 'listening');
  peers.push(receiver);
  return receiver;
}
function session(receiver: Receiver, credentials?: LegacyAirPlayCredentials): LegacyAirPlayPlaybackSession {
  const playback = new LegacyAirPlayPlaybackSession('127.0.0.1', receiver.port, credentials);
  sessions.push(playback);
  return playback;
}

describe('LegacyAirPlayPlaybackSession', () => {
  it('plays a relative start position and reads XML status on the linked control session', async () => {
    const receiver = await peer();
    const playback = session(receiver);
    await playback.playUrl(MEDIA_URL, 5, { duration: 20 });
    expect(await playback.getStatus()).toEqual({ state: 'playing', duration: 20, position: 5, rate: 1 });
    const play = receiver.requests.find(request => request.line === 'POST /play HTTP/1.1')!;
    const reverse = receiver.requests.find(request => request.line === 'POST /reverse HTTP/1.1')!;
    expect(play.headers['content-type']).toBe('text/parameters');
    expect(play.body.toString()).toBe(`Content-Location: ${MEDIA_URL}\r\nStart-Position: 0.25\r\n`);
    expect(reverse.headers['x-apple-purpose']).toBe('event');
    expect(reverse.headers['x-apple-session-id']).toBe(play.headers['x-apple-session-id']);
    expect(reverse.socket).not.toBe(play.socket);
    playback.close();
    await receiver.drained();
  });

  it('parses fragmented upgrade and coalesced documented states, then ACKs stop before closing', async () => {
    const receiver = await peer({ fragmentedUpgrade: true });
    const playback = session(receiver);
    await playback.playUrl(MEDIA_URL);
    await receiver.waitFor(request => request.line === 'HTTP/1.1 200 OK' && receiver.timeline.filter(event => event === 'ack').length === 4);
    expect(await playback.getStatus()).toEqual({ state: 'playing', duration: 20, position: 5, rate: 1 });
    const acknowledgement = receiver.waitFor(request => request.line === 'HTTP/1.1 200 OK', receiver.requests.length);
    receiver.reverse!.write(event('stopped'));
    await acknowledgement;
    await receiver.drained();
    expect(receiver.timeline.slice(-2)).toEqual(['ack', 'reverse-closed']);
    await expect(playback.getStatus()).rejects.toBeInstanceOf(Error);
  });

  it('rejects concurrent and repeated starts without sending another play request', async () => {
    const receiver = await peer({ hold: 'play' });
    const playback = session(receiver);
    const started = playback.playUrl(MEDIA_URL);
    const request = await receiver.waitFor(request => request.line === 'POST /play HTTP/1.1');
    await expect(playback.playUrl(MEDIA_URL)).rejects.toBeInstanceOf(Error);
    receiver.reply(request.socket);
    await started;
    await expect(playback.playUrl(MEDIA_URL)).rejects.toBeInstanceOf(Error);
    expect(receiver.requests.filter(request => request.line === 'POST /play HTTP/1.1')).toHaveLength(1);
  });

  it.each(['reverse', 'status'] as const)('closes both sockets and rejects a pending %s operation idempotently', async hold => {
    const receiver = await peer({ hold });
    const playback = session(receiver);
    if (hold === 'status') await playback.playUrl(MEDIA_URL);
    const pending = hold === 'reverse' ? playback.playUrl(MEDIA_URL) : playback.getStatus();
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await receiver.waitFor(request => request.line === (hold === 'reverse' ? 'POST /reverse HTTP/1.1' : 'GET /playback-info HTTP/1.1'));
    playback.close(); playback.close();
    await rejected;
    await receiver.drained();
    expect(receiver.accepted).toBe(2);
  });

  it.each(['reverse', 'status'] as const)('times out an unanswered %s operation and releases both sockets', async hold => {
    const receiver = await peer({ hold });
    const playback = session(receiver);
    if (hold === 'status') await playback.playUrl(MEDIA_URL);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = hold === 'reverse' ? playback.playUrl(MEDIA_URL) : playback.getStatus();
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await receiver.waitFor(request => request.line === (hold === 'reverse' ? 'POST /reverse HTTP/1.1' : 'GET /playback-info HTTP/1.1'));
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await receiver.drained();
    expect(receiver.accepted).toBe(2);
  });

  it('fails closed on a password challenge without an authentication fallback or replay', async () => {
    const receiver = await peer({ rejectPlay: true });
    const playback = session(receiver);
    await expect(playback.playUrl(MEDIA_URL)).rejects.toBeInstanceOf(Error);
    await receiver.drained();
    expect(receiver.requests.filter(request => request.line === 'POST /play HTTP/1.1')).toHaveLength(1);
    expect(receiver.requests.some(request => request.headers.authorization !== undefined)).toBe(false);
  });

  it('fails the session when the reverse connection disappears', async () => {
    const receiver = await peer();
    const playback = session(receiver);
    await playback.playUrl(MEDIA_URL);
    receiver.reverse!.destroy();
    await receiver.drained();
    await expect(playback.getStatus()).rejects.toBeInstanceOf(Error);
  });

  it.each([
    ['malformed XML', Buffer.from('<plist><dict><key>duration</key><real>20</dict></plist>')],
    ['internal entities', Buffer.from('<!DOCTYPE plist [<!ENTITY secret "private">]><plist><dict/></plist>')],
    ['binary plist', Buffer.from('bplist00')],
    ['duplicate fields', plist('<key>rate</key><real>1</real><key>rate</key><real>0</real>')],
    ['negative position', plist('<key>position</key><real>-1</real>')],
    ['wrong field type', plist('<key>duration</key><array/>')],
  ])('rejects %s in status without retaining either socket', async (_name, status) => {
    const receiver = await peer({ status });
    const playback = session(receiver);
    await playback.playUrl(MEDIA_URL);
    await expect(playback.getStatus()).rejects.toBeInstanceOf(Error);
    await receiver.drained();
    expect(receiver.sockets.size).toBe(0);
  });

  it.each([
    ['oversized body', 'HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n'],
    ['ambiguous framing', 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\n'],
  ])('rejects %s framing before waiting for the announced body', async (_name, rawStatus) => {
    const receiver = await peer({ rawStatus });
    const playback = session(receiver);
    await playback.playUrl(MEDIA_URL);
    await expect(playback.getStatus()).rejects.toBeInstanceOf(Error);
    await receiver.drained();
    expect(receiver.requests.filter(request => request.line === 'GET /playback-info HTTP/1.1')).toHaveLength(1);
  });

  it.each([
    ['malformed XML', eventBody(Buffer.from('<plist><dict>'))],
    ['empty notice', eventBody(Buffer.alloc(0))],
    ['unsupported state', event('invalid')],
    ['oversized frame', Buffer.from('POST /event HTTP/1.1\r\nContent-Length: 1048577\r\n\r\n')],
  ])('rejects a %s reverse event without acknowledging it', async (_name, frame) => {
    const receiver = await peer();
    const playback = session(receiver);
    await playback.playUrl(MEDIA_URL);
    receiver.reverse!.write(frame);
    await receiver.drained();
    await expect(playback.getStatus()).rejects.toBeInstanceOf(Error);
    expect(receiver.timeline).not.toContain('ack');
  });

  it('proves the legacy seed on the HTTP control socket before allowing play', async () => {
    const receiver = await peer({ verify: 'valid' });
    const playback = session(receiver, { clientId: '0123456789ABCDEF', seed: Buffer.alloc(32, 7) });
    await playback.playUrl(MEDIA_URL);
    expect(receiver.verified).toBe(true);
    expect(receiver.requests.map(request => request.line)).toEqual([
      'POST /pair-verify HTTP/1.1', 'POST /pair-verify HTTP/1.1', 'POST /reverse HTTP/1.1', 'POST /play HTTP/1.1',
    ]);
    expect(receiver.requests[0]!.socket).toBe(receiver.requests[1]!.socket);
    expect(receiver.requests[0]!.socket).toBe(receiver.requests[3]!.socket);
  });

  it('does not play or open a reverse socket after an unsupported pair-verify reply', async () => {
    const receiver = await peer({ verify: 'short-reply' });
    const playback = session(receiver, { clientId: '0123456789ABCDEF', seed: Buffer.alloc(32, 7) });
    await expect(playback.playUrl(MEDIA_URL)).rejects.toBeInstanceOf(Error);
    await receiver.drained();
    expect(receiver.accepted).toBe(1);
    expect(receiver.requests.map(request => request.line)).toEqual(['POST /pair-verify HTTP/1.1']);
  });

  it('rejects invalid URLs and unrepresentable start positions before network ownership', async () => {
    const receiver = await peer();
    const playback = session(receiver);
    for (const [url, position, duration] of [
      ['https://example.test/a\r\nX: y', 0, undefined], ['ftp://example.test/a', 0, undefined],
      [MEDIA_URL, 1, undefined], [MEDIA_URL, 2, 1], [MEDIA_URL, NaN, 20],
    ] as const) {
      await expect(playback.playUrl(url, position, { duration })).rejects.toBeInstanceOf(Error);
    }
    await expect(playback.getStatus()).rejects.toBeInstanceOf(Error);
    expect(receiver.accepted).toBe(0);
  });

  it.each([null, false, { clientId: 'hap', seed: Buffer.alloc(32) }, { clientId: '0123456789ABCDEF', seed: Buffer.alloc(16) }])(
    'does not start unauthenticated playback with invalid explicit credentials: %j', async credentials => {
      const receiver = await peer();
      await expect((async () => session(receiver, credentials as LegacyAirPlayCredentials).playUrl(MEDIA_URL))()).rejects.toBeInstanceOf(Error);
      expect(receiver.accepted).toBe(0);
    },
  );
});
