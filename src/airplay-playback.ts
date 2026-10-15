/** Authenticated AirPlay 2 URL playback, based on pyatv 0.18.0 (d88abc960e188d3cd2498d19117e75d7711d8600). */
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { randomUUID, randomBytes } from 'node:crypto';
import { isIPv6, type Socket } from 'node:net';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import plist from 'plist';
import { connectSocket, hostForURL, parseHTTPMessage, type ParsedHTTP } from './connection.js';
import { PairVerify } from './auth/pair-verify.js';
import type { HAPCredentials } from './auth/types.js';
import { HAPSession } from './util/hap-session.js';
import { hkdfSha512 } from './util/crypto.js';

/** Control/status/event messages are bounded, not media payloads (passed as parseHTTPMessage's body cap). */
const MAX_REPLY_BYTES = 1024 * 1024;


/** bplist-creator exposes Real at runtime, but its bundled declaration omits it. */
const PlistReal = (bplistCreator as typeof bplistCreator & { Real: new (value: number) => object }).Real;

/** Receiver status; idle means no duration is reported (including startup buffering). */
export interface AirPlayPlaybackStatus {
  state: 'playing' | 'paused' | 'idle';
  duration?: number;
  position?: number;
  rate?: number;
}

/** One URL playback session. Keep it open while playing; close stops playback and frees all resources. */
export class AirPlayPlaybackSession {
  private socket?: Socket;
  private events?: Socket;
  private timing?: DatagramSocket;
  private timingPeer?: { address: string; port?: number };
  private cancelTimingBind?: () => void;
  private cipher?: HAPSession;
  private encrypted: Buffer = Buffer.alloc(0);
  private plain: Buffer = Buffer.alloc(0);
  private pending?: { resolve: (reply: ParsedHTTP) => void; reject: (error: Error) => void };
  private heartbeat?: ReturnType<typeof setInterval>;
  private cseq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private closed = false;
  private readonly sessionId = randomUUID().toLowerCase();
  private readonly dacp = randomBytes(8).toString('hex');
  private readonly rtspId = Math.floor(Math.random() * 0xffffffff);
  private failure?: Error;

  constructor(private host: string, private port: number, private credentials: HAPCredentials) {}

  /** Start a reachable HTTP(S) media URL. Resolves when accepted, not when media ends; position is seconds. */
  async playUrl(url: string, position = 0): Promise<void> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('Invalid media URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Media URL must use HTTP or HTTPS');
    if (!Number.isFinite(position) || position < 0) throw new Error('Position must be non-negative seconds');
    if (this.started || this.closed) throw new Error('Playback session already started or closed');
    this.started = true;
    try {
      const socket = await connectSocket(this.host, this.port);
      if (this.closed) { socket.destroy(); throw new Error('Playback session closed'); }
      this.socket = socket;
      socket.on('data', (data: Buffer) => this.receive(data));
      socket.on('error', error => this.fail(error));
      socket.on('close', () => { if (!this.closed) this.fail(new Error('Playback connection closed')); });
      const keys = await new PairVerify(this.host, this.port, this.credentials, {
        post: async (path, body) => (await this.request('POST', path, 'HTTP/1.1', body, { 'X-Apple-HKP': '3', 'Content-Type': 'application/octet-stream', 'User-Agent': 'AirPlay/320.20' })).body,
        destroy() {}, // Playback owns the socket after verification.
      }).verify();
      this.cipher = new HAPSession(keys.outputKey, keys.inputKey);
      if (this.closed) throw new Error('Playback session closed');
      this.timingPeer = { address: socket.remoteAddress! };
      await this.openTiming(socket.localAddress!);
      if (this.closed) throw new Error('Playback session closed');
      const mac = randomBytes(6).toString('hex').match(/../g)!.join(':').toUpperCase();
      const setup = await this.request('SETUP', this.uri, 'RTSP/1.0', bplistCreator({
        deviceID: mac, macAddress: mac, sessionUUID: randomUUID().toUpperCase(), timingPort: this.timing!.address().port,
        timingProtocol: 'NTP', isMultiSelectAirPlay: true, groupContainsGroupLeader: false,
        model: 'iPhone14,3', name: 'Node ATV', osBuildVersion: '20F66', osName: 'iPhone OS', osVersion: '16.5',
        senderSupportsRelay: false, sourceVersion: '690.7.1', statsCollectionEnabled: false,
      }));
      const setupInfo = parseBuffer(setup.body)[0] as Record<string, unknown>;
      const eventPort = setupInfo.eventPort;
      const timingPort = setupInfo.timingPort;
      if (timingPort !== undefined) {
        if (typeof timingPort !== 'number' || !Number.isInteger(timingPort) || timingPort < 1 || timingPort > 65535) throw new Error('SETUP invalid timingPort');
        this.timingPeer!.port = timingPort;
      }
      if (typeof eventPort !== 'number' || !Number.isInteger(eventPort) || eventPort < 1 || eventPort > 65535) throw new Error('SETUP missing valid eventPort');
      const eventCipher = new HAPSession(
        await hkdfSha512(keys.sharedSecret, 'Events-Salt', 'Events-Read-Encryption-Key', 32),
        await hkdfSha512(keys.sharedSecret, 'Events-Salt', 'Events-Write-Encryption-Key', 32));
      const events = await connectSocket(this.host, eventPort);
      if (this.closed) { events.destroy(); throw new Error('Playback session closed'); }
      this.events = events;
      let encrypted: Buffer = Buffer.alloc(0), plain: Buffer = Buffer.alloc(0);
      events.on('data', (data: Buffer) => {
        try {
          encrypted = Buffer.concat([encrypted, data]);
          const decoded = eventCipher.decryptAvailable(encrypted); encrypted = Buffer.from(decoded.rest);
          plain = Buffer.concat([plain, decoded.plaintext]);
          let message: ParsedHTTP | null;
          while ((message = parseHTTPMessage(plain, MAX_REPLY_BYTES))) {
            plain = Buffer.from(plain.subarray(message.totalSize));
            const protocol = message.startLine.split(' ')[2];
            if (!['RTSP/1.0', 'HTTP/1.1'].includes(protocol)) throw new Error('Invalid event request');
            events.write(eventCipher.encrypt(Buffer.from(`${protocol} 200 OK\r\nContent-Length: 0\r\nAudio-Latency: 0\r\n${message.headers.cseq ? `CSeq: ${message.headers.cseq}\r\n` : ''}${message.headers.server ? `Server: ${message.headers.server}\r\n` : ''}\r\n`)));
          }
        } catch (error) { this.fail(error as Error); }
      });
      events.on('error', error => this.fail(error));
      events.on('close', () => { if (!this.closed) this.fail(new Error('Playback event connection closed')); });
      await this.request('POST', '/feedback', 'RTSP/1.0');
      await this.request('RECORD', this.uri, 'RTSP/1.0');
      await this.request('POST', '/play', 'HTTP/1.1', bplistCreator({
        'Content-Location': parsed.href, 'Start-Position-Seconds': new PlistReal(position), uuid: randomUUID(), streamType: 1,
        mediaType: 'file', mightSupportStorePastisKeyRequests: true, playbackRestrictions: 0,
        secureConnectionMs: 22, volume: new PlistReal(1), infoMs: 122, connectMs: 18, authMs: 0, bonjourMs: 0,
        referenceRestrictions: 3, SenderMACAddress: mac, model: 'iPhone14,3', postAuthMs: 0,
        clientBundleID: 'dev.node-atv', clientProcName: 'dev.node-atv', osBuildVersion: '20G1116', rate: new PlistReal(1),
      }), { 'X-Apple-ProtocolVersion': '1', 'X-Apple-Session-ID': this.sessionId, 'X-Apple-Stream-ID': '1' });
      await this.request('PUT', '/setProperty?isInterestedInDateRange', 'RTSP/1.0', bplistCreator({ value: true }));
      await this.request('PUT', '/setProperty?actionAtItemEnd', 'RTSP/1.0', bplistCreator({ value: 0 }));
      await this.request('POST', '/rate?value=1.000000', 'RTSP/1.0');
      for (const name of ['forwardEndTime', 'reverseEndTime']) await this.request('PUT', `/setProperty?${name}`, 'RTSP/1.0', bplistCreator({ value: { flags: 0, value: 0, epoch: 0, timescale: 0 } }));
      this.heartbeat = setInterval(() => {
        if (!this.pending) void this.request('POST', '/feedback', 'RTSP/1.0').catch(error => this.fail(error));
      }, 2000);
    } catch (error) { this.fail(error as Error); throw error; }
  }

  /** Fetch receiver /playback-info; rejects protocol/media errors and closes the failed session. */
  async getStatus(): Promise<AirPlayPlaybackStatus> {
    if (this.failure) throw this.failure;
    if (!this.socket || !this.cipher) throw new Error('Playback session not connected');
    try {
      const reply = await this.request('GET', '/playback-info', 'HTTP/1.1');
      const info = reply.body.length ? (reply.body.subarray(0, 6).toString() === 'bplist'
        ? parseBuffer(reply.body)[0] : plist.parse(reply.body.toString('utf8'))) as Record<string, unknown> : {};
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('Invalid playback status');
      if (info.error) { const error = info.error as Record<string, unknown>; throw new Error(`Playback error ${error.code ?? 'unknown'} (${error.domain ?? 'unknown domain'})`); }
      for (const field of ['duration', 'position', 'rate']) if (info[field] !== undefined && (typeof info[field] !== 'number' || !Number.isFinite(info[field]))) throw new Error(`Invalid playback ${field}`);
      return { state: info.duration === undefined ? 'idle' : info.rate === 0 ? 'paused' : 'playing', duration: info.duration as number | undefined, position: info.position as number | undefined, rate: info.rate as number | undefined };
    } catch (error) { this.fail(error as Error); throw error; }
  }

  /** Stop by closing the dedicated connection (pyatv AirPlayStream.stop); idempotent. */
  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.pending?.reject(this.failure ?? new Error('Playback session closed'));
    this.pending = undefined;
    this.socket?.destroy(); this.events?.destroy();
    this.socket = undefined; this.events = undefined;
    this.cancelTimingBind?.(); this.cancelTimingBind = undefined;
    this.timing?.close(); this.timing = undefined;
  }

  private fail(error: Error): void { this.failure ??= error; this.close(); }
  private get uri(): string {
    if (!this.socket || this.closed) throw this.failure ?? new Error('Playback session closed');
    return `rtsp://${hostForURL(this.socket.localAddress ?? '')}/${this.rtspId}`;
  }

  /** Reply to the connected peer (and negotiated port, if present); optional UDP sends cannot fail playback. */
  private async openTiming(address: string): Promise<void> {
    if (this.closed) throw new Error('Playback session closed');
    const timing = createSocket(isIPv6(address) ? 'udp6' : 'udp4'); this.timing = timing;
    timing.on('message', (data, remote) => {
      const peer = this.timingPeer;
      if (this.closed || !peer || remote.address !== peer.address || (peer.port !== undefined && remote.port !== peer.port) || data.length !== 32) return;
      const reply = Buffer.alloc(32); reply[0] = data[0]; reply[1] = 0xd3; reply.writeUInt16BE(7, 2);
      data.copy(reply, 8, 24, 32);
      const now = Date.now() / 1000 + 2208988800;
      for (const offset of [16, 24]) { reply.writeUInt32BE(Math.floor(now) >>> 0, offset); reply.writeUInt32BE(Math.floor((now % 1) * 0x100000000), offset + 4); }
      timing.send(reply, remote.port, remote.address, () => {});
    });
    timing.on('error', error => this.fail(error));
    await new Promise<void>((resolve, reject) => {
      this.cancelTimingBind = () => reject(this.failure ?? new Error('Playback session closed'));
      timing.once('error', reject);
      timing.bind(0, address, () => {
        timing.removeListener('error', reject);
        this.cancelTimingBind = undefined;
        resolve();
      });
    });
  }

  /** Serialize HTTP and RTSP requests so feedback cannot consume another request's reply. */
  private request(method: string, path: string, protocol: string, body?: Buffer, headers: Record<string, string> = {}): Promise<ParsedHTTP> {
    const operation = this.queue.then(() => new Promise<ParsedHTTP>((resolve, reject) => {
      if (this.closed || !this.socket) { reject(this.failure ?? new Error('Playback session closed')); return; }
      const cseq = ++this.cseq;
      const timer = setTimeout(() => this.fail(new Error(`Timeout waiting for ${method} ${path}`)), 5000);
      this.pending = { resolve: reply => {
        clearTimeout(timer); this.pending = undefined;
        if (!/^HTTP\/1\.[01] |^RTSP\/1\.0 /.test(reply.startLine)) { reject(new Error('Invalid AirPlay response')); return; }
        if (protocol === 'RTSP/1.0' && reply.headers.cseq !== String(cseq)) { reject(new Error('AirPlay CSeq mismatch')); return; }
        const code = Number(reply.startLine.split(' ')[1]);
        if (!Number.isInteger(code) || code < 200 || code >= 300) reject(new Error(`AirPlay ${code} from ${path}`)); else resolve(reply);
      }, reject: error => { clearTimeout(timer); this.pending = undefined; reject(error); } };
      const allHeaders = { Host: `${hostForURL(this.host, false)}:${this.port}`, Connection: 'keep-alive', 'User-Agent': 'AirPlay/550.10', CSeq: String(cseq), 'DACP-ID': this.dacp, 'Active-Remote': String(this.rtspId), 'Client-Instance': this.dacp, ...(body ? { 'Content-Type': 'application/x-apple-binary-plist' } : {}), ...headers, 'Content-Length': String(body?.length ?? 0) };
      const message = Buffer.concat([Buffer.from(`${method} ${path} ${protocol}\r\n${Object.entries(allHeaders).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`), body ?? Buffer.alloc(0)]);
      try { this.socket.write(this.cipher ? this.cipher.encrypt(message) : message, error => { if (error) this.fail(error); }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    }));
    this.queue = operation.catch(() => {});
    return operation;
  }

  private receive(data: Buffer): void {
    try {
      if (this.cipher) {
        this.encrypted = Buffer.concat([this.encrypted, data]);
        const decoded = this.cipher.decryptAvailable(this.encrypted); this.encrypted = Buffer.from(decoded.rest);
        this.plain = Buffer.concat([this.plain, decoded.plaintext]);
      } else this.plain = Buffer.concat([this.plain, data]);
      let reply: ParsedHTTP | null;
      while ((reply = parseHTTPMessage(this.plain, MAX_REPLY_BYTES))) { this.plain = Buffer.from(this.plain.subarray(reply.totalSize)); this.pending?.resolve(reply); }
    } catch (error) { this.fail(error as Error); }
  }
}
