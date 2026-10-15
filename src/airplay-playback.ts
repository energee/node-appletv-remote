/** Authenticated AirPlay 2 URL playback over the tvOS 18+ remote-control queue. */
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { randomUUID, randomBytes } from 'node:crypto';
import { isIPv6, type Socket } from 'node:net';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { connectSocket, hostForURL, parseHTTPMessage, type ParsedHTTP } from './connection.js';
import { PairVerify } from './auth/pair-verify.js';
import type { HAPCredentials } from './auth/types.js';
import { HAPSession } from './util/hap-session.js';
import { hkdfSha512 } from './util/crypto.js';
import { timingReply } from './raop/packets.js';

/** Control/status/event messages are bounded, not media payloads (passed as parseHTTPMessage's body cap). */
const MAX_REPLY_BYTES = 1024 * 1024;


/** bplist-creator exposes Real at runtime, but its bundled declaration omits it. */
const PlistReal = (bplistCreator as typeof bplistCreator & { Real: new (value: number) => object }).Real;

/** Receiver status; idle means no playing or paused item (startup buffering, unreachable media, or ended). */
export interface AirPlayPlaybackStatus {
  state: 'playing' | 'paused' | 'idle';
  duration?: number;
  position?: number;
  rate?: number;
}

/**
 * Seconds from a CMTime dict ({ value, timescale, flags }); undefined unless flags marks it valid.
 * Nanosecond values pass 2^32 within seconds; bplist-parser >= 0.5 is required to decode them as 64-bit.
 */
function cmTime(time: unknown): number | undefined {
  const { value, timescale, flags } = (time ?? {}) as Record<string, unknown>;
  if (typeof value !== 'number' || typeof timescale !== 'number' || timescale <= 0 || !(Number(flags) & 1)) return undefined;
  return value / timescale;
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
  private readonly sessionId = randomUUID().toUpperCase();
  /** Stream ID from the type-130 SETUP; addresses every /command. */
  private streamId = '1';
  /** Last playbackState pushed on the event channel (loading/playing/paused/stopped). */
  private pushedState?: string;
  private messageId = 0;
  /** playbackInfo requests awaiting their event-channel response, by messageID; close() rejects them. */
  private infoWaiters = new Map<number, { resolve: (info: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly dacp = randomBytes(8).toString('hex');
  private readonly rtspId = Math.floor(Math.random() * 0xffffffff);
  private failure?: Error;

  constructor(private host: string, private port: number, private credentials: HAPCredentials) {}

  /** Queue a reachable HTTP(S) media URL. Resolves when accepted, not when media starts or ends; position is seconds. */
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
            this.handleEvent(message.body);
            events.write(eventCipher.encrypt(Buffer.from(`${protocol} 200 OK\r\nContent-Length: 0\r\nAudio-Latency: 0\r\n${message.headers.cseq ? `CSeq: ${message.headers.cseq}\r\n` : ''}${message.headers.server ? `Server: ${message.headers.server}\r\n` : ''}\r\n`)));
          }
        } catch (error) { this.fail(error as Error); }
      });
      events.on('error', error => this.fail(error));
      events.on('close', () => { if (!this.closed) this.fail(new Error('Playback event connection closed')); });
      await this.request('POST', '/feedback', 'RTSP/1.0');
      await this.request('RECORD', this.uri, 'RTSP/1.0');
      // tvOS 18+ answers the older /play + /playback-info flow with 500. URL playback now queues an item over a
      // remote-control stream; state is pushed on the event channel.
      const stream = parseBuffer((await this.request('SETUP', this.uri, 'RTSP/1.0', bplistCreator({ streams: [{
        type: 130, controlType: 1, channelID: randomUUID().toUpperCase(), clientUUID: randomUUID().toUpperCase(),
        clientTypeUUID: 'A6B27562-B43A-4F2D-B75F-82391E250194',
      }] }))).body)[0] as { streams?: Array<{ streamID?: unknown }> };
      const streamId = stream?.streams?.[0]?.streamID;
      if (typeof streamId !== 'number' && typeof streamId !== 'string') throw new Error('SETUP missing remote-control streamID');
      this.streamId = String(streamId);
      // tvOS reads the start as a CMTime under Start-Position; Start-Position-Seconds is ignored.
      const start = position ? { 'Start-Position': { value: Math.round(position * 1000), timescale: 1000, flags: 1, epoch: 0 } } : {};
      await this.command({ type: 'insertPlayQueueItem', item: { uuid: randomUUID().toUpperCase(), mediaType: 'file', 'Content-Location': parsed.href, ...start } });
      await this.command({ type: 'setProperty', property: 'actionAtItemEnd', value: 1 });
      await this.command({ type: 'setRate', rate: new PlistReal(1) });
      this.heartbeat = setInterval(() => {
        if (!this.pending) void this.request('POST', '/feedback', 'RTSP/1.0').catch(error => this.fail(error));
      }, 2000);
    } catch (error) { this.fail(error as Error); throw error; }
  }

  /** Last receiver playbackState pushed (loading/playing/paused/stopped), finer than getStatus().state; no round trip. */
  get state(): string | undefined { return this.pushedState; }

  /** Ask the receiver for playbackInfo over /command; rejects protocol/media errors and closes the failed session. */
  async getStatus(): Promise<AirPlayPlaybackStatus> {
    if (this.failure) throw this.failure;
    if (!this.socket || !this.cipher) throw new Error('Playback session not connected');
    const messageID = ++this.messageId;
    try {
      const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for playbackInfo')), 5000);
        this.infoWaiters.set(messageID, { resolve: info => { clearTimeout(timer); resolve(info); }, reject: error => { clearTimeout(timer); reject(error); } });
      });
      reply.catch(() => {}); // Observed below; avoids an unhandled rejection if the command itself fails first.
      await this.command({ type: 'playbackInfo', kind: 'request', messageID });
      const info = await reply;
      if (info.error) { const error = info.error as Record<string, unknown>; throw new Error(`Playback error ${error.code ?? 'unknown'} (${error.domain ?? 'unknown domain'})`); }
      // Before the queued item is ready, tvOS replies { readyToPlay: false, item } with no playbackState.
      const received = info.playbackState ?? 'loading';
      if (typeof received !== 'string' || !['loading', 'playing', 'paused', 'stopped'].includes(received)) throw new Error('Invalid playback state');
      const state = received === 'playing' || received === 'paused' ? received : 'idle';
      if (info.rate !== undefined && (typeof info.rate !== 'number' || !Number.isFinite(info.rate))) throw new Error('Invalid playback rate');
      return Object.fromEntries(Object.entries({ state, duration: cmTime(info.duration), position: cmTime(info.position), rate: info.rate }).filter(([, v]) => v !== undefined)) as unknown as AirPlayPlaybackStatus;
    } catch (error) { this.fail(error as Error); throw error; }
    finally { this.infoWaiters.delete(messageID); }
  }

  /** Decode one event-channel /command: params.data holds a nested bplist (state push or playbackInfo reply). */
  private handleEvent(body: Buffer): void {
    if (!body.length) return;
    const data = (parseBuffer(body)[0] as { params?: { data?: unknown } } | undefined)?.params?.data;
    if (!Buffer.isBuffer(data)) return; // updateInfo and other receiver notices carry no nested data.
    const event = parseBuffer(data)[0] as Record<string, unknown>;
    if (event.kind === 'response' && typeof event.messageID === 'number') this.infoWaiters.get(event.messageID)?.resolve(event.info as Record<string, unknown> ?? {});
    else if (event.type === 'playbackState' && typeof event.name === 'string') this.pushedState = event.name;
  }

  /** POST a remote-control command; the receiver expects its plist nested as params.data. */
  private command(data: Record<string, unknown>): Promise<ParsedHTTP> {
    return this.request('POST', '/command', 'HTTP/1.1', bplistCreator({ params: { data: bplistCreator(data) } }),
      { 'X-Apple-ProtocolVersion': '1', 'X-Apple-Session-ID': this.sessionId, 'X-Apple-StreamID': this.streamId });
  }

  /** Stop by closing the dedicated connection; idempotent. */
  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.pending?.reject(this.failure ?? new Error('Playback session closed'));
    this.pending = undefined;
    for (const waiter of this.infoWaiters.values()) waiter.reject(this.failure ?? new Error('Playback session closed'));
    this.infoWaiters.clear();
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
      if (this.closed || !peer || remote.address !== peer.address || (peer.port !== undefined && remote.port !== peer.port)) return;
      const now = Date.now();
      const reply = timingReply(data, now, now);
      if (reply) timing.send(reply, remote.port, remote.address, () => {});
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
