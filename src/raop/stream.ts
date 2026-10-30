/**
 * One-shot RAOP PCM streaming with two profiles chosen from the TXT record. Legacy receivers get
 * cleartext L16 with optional legacy PIN verification. AirPlay 2 receivers (features bit 38 or 48)
 * get realtime PCM: HAP pair-verify with stored credentials, encrypted RTSP, plist SETUPs and an
 * event channel (`airplay2.ts`), then the same paced loop with every audio packet sealed (#22).
 */
import { isIPv4, type Socket } from 'node:net';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { audioPacket, sealAudioPacket, timingReply, syncPacket, PacketHistory, FRAMES_PER_PACKET, SAMPLE_RATE, PACKET_BYTES } from './packets.js';
import { legacyDigestAuthorization, parseLegacyDigestChallenge } from './digest.js';
import { setupAirPlay2Audio, type AirPlay2Audio } from './airplay2.js';
import { verifyLegacyPairing } from '../auth/legacy-pair-verify.js';
import { connectSocket, parseHTTPMessage } from '../connection.js';
import { encodeDmap } from '../dmap/codec.js';
import type { HAPSession } from '../util/hap-session.js';
import type { HAPCredentials } from '../auth/types.js';

/** Finite raw PCM chunks; streamed chunks are Buffers of at most 65,536 bytes. */
export type RaopPcmSource = Buffer | AsyncIterable<Buffer>;

export interface RaopMetadata {
  title?: string;
  artist?: string;
  album?: string;
  /** JPEG artwork, at most 1 MiB. */
  artwork?: Buffer;
}
export interface RaopStreamOptions {
  /** Cancellation interrupts source reads, setup or playback and performs bounded teardown. */
  signal?: AbortSignal;
  /** Receiver volume percentage, 0 (mute) through 100 (0 dB). */
  volume?: number;
  /** Text metadata and optional JPEG artwork. */
  metadata?: RaopMetadata;
  /** Finite media duration in seconds; sends an initial RAOP progress update. */
  duration?: number;
  /** Previously paired legacy AirPlay seed (32 bytes), NOT HAP credentials. Legacy receivers only. No pairing/storage access. */
  legacySeed?: Buffer;
  /** HAP credentials from `PairSetup` (as stored by `atv pair`). Required for, and only accepted by, AirPlay 2 receivers. */
  credentials?: HAPCredentials;
  /** Legacy RAOP receiver password. Never supported for AirPlay 2 receivers. */
  password?: string;
}
interface Response { headers: Record<string, string>; code: number; body: Buffer; wwwAuthenticate: string[] }

/** HTTP/1.1 pairing endpoints sent without CSeq on the RTSP socket; everything else is CSeq-correlated RTSP/1.0. */
const HTTP_PAIRING_URIS = new Set(['/pair-verify', '/pair-pin-start', '/pair-setup']);

/**
 * Serialized HTTP pairing and CSeq-correlated RTSP audio requests on one socket.
 * After `encryptWith`, all traffic in both directions uses HAP-encrypted framing.
 * Exported for tests only; not part of the public API (`src/index.ts`).
 */
export class RtspClient {
  /** Plaintext received and not yet parsed. */
  private input = Buffer.alloc(0);
  /** Ciphertext received and not yet forming a complete frame (only after `encryptWith`). */
  private encrypted = Buffer.alloc(0);
  private cipher?: HAPSession;
  /** Request URI; set by setLocalUri before the first request. */
  private uri = '';
  private cseq = 0;
  private abandoned = new Set<number>();
  private readonly senderId = randomBytes(8).toString('hex').toUpperCase();
  private readonly activeRemote = randomBytes(4).readUInt32BE();
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { sequence?: number; protocol: 'HTTP/1.1' | 'RTSP/1.0'; resolve: (response: Response) => void; reject: (error: Error) => void };
  /** Takes ownership of a connected socket from `connectSocket`. */
  constructor(readonly socket: Socket, onFailure: (error: Error) => void) {
    this.socket.on('error', error => { this.pending?.reject(error); onFailure(error); });
    this.socket.on('close', () => { const error = new Error('RAOP control connection closed'); this.pending?.reject(error); onFailure(error); });
    this.socket.on('data', (chunk: Buffer) => {
      try {
        if (this.cipher) {
          const { plaintext, rest } = this.cipher.decryptAvailable(Buffer.concat([this.encrypted, chunk]));
          this.encrypted = Buffer.from(rest);
          this.input = Buffer.concat([this.input, plaintext]);
        } else this.input = Buffer.concat([this.input, chunk]);
        this.parse();
      } catch (error) { this.pending?.reject(error as Error); onFailure(error as Error); this.socket.destroy(); }
    });
  }
  /** Shared HTTP framing (64 KiB header and body caps); RTSP status, a single CSeq and CSeq correlation are checked here. */
  private parse(): void {
    while (true) {
      const message = parseHTTPMessage(this.input, 65536);
      if (!message) return;
      const status = /^(RTSP\/1\.0|HTTP\/1\.1) (\d{3})(?: |$)/.exec(message.startLine);
      if (!status) throw new Error('Malformed RAOP RTSP response');
      // parseHTTPMessage keeps the last duplicate header, so a repeated CSeq is rejected from the raw header block.
      if ((this.input.subarray(0, message.totalSize - message.body.length).toString().match(/\r\ncseq\s*:/gi)?.length ?? 0) > 1) throw new Error('Duplicate RAOP CSeq header');
      const { headers, body } = message;
      const headerBlock = this.input.subarray(0, message.totalSize - message.body.length).toString('latin1');
      const wwwAuthenticate = headerBlock.split('\r\n').slice(1).flatMap(line => {
        const separator = line.indexOf(':');
        return separator > 0 && line.slice(0, separator).trim().toLowerCase() === 'www-authenticate' ? [line.slice(separator + 1).trim()] : [];
      });
      this.input = this.input.subarray(message.totalSize);
      if (status[1] === 'RTSP/1.0' && this.abandoned.delete(Number(headers.cseq))) continue;
      if (!this.pending || status[1] !== this.pending.protocol) throw new Error('Unexpected RAOP response protocol');
      if (this.pending.sequence !== undefined && headers.cseq !== String(this.pending.sequence)) throw new Error('Unexpected RAOP CSeq');
      this.pending.resolve({ headers, code: Number(status[2]), body, wwwAuthenticate });
    }
  }
  /**
   * Encrypt every later write with `session` and decrypt every later read before HTTP parsing.
   * Call it after the pair-verify (or transient pairing) response and before the next request.
   * A frame that fails authentication fails the pending request and the client, and destroys the socket.
   * @throws (and destroys the socket) if unparsed plaintext is buffered or a request is pending:
   * leftover bytes would otherwise prefix the first decrypted response unauthenticated (#60).
   */
  encryptWith(session: HAPSession): void {
    const problem = this.input.length ? 'unparsed plaintext buffered' : this.pending ? 'a request is pending' : undefined;
    if (problem) {
      const error = new Error(`RAOP cannot switch to encryption: ${problem}`);
      this.socket.destroy(error);
      throw error;
    }
    this.cipher = session;
  }
  setLocalUri(sessionId: number): void { this.uri = `rtsp://${this.socket.localAddress}/${sessionId}`; }
  request(method: string, headers: Record<string, string> = {}, body: Buffer = Buffer.alloc(0), signal?: AbortSignal, timeout = 5000, uri = this.uri, allowError = false): Promise<Response> {
    const request = this.queue.then(() => new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('RAOP aborted')); return; }
      if (this.socket.destroyed) { reject(new Error('RAOP control connection closed')); return; }
      const http = method === 'POST' && HTTP_PAIRING_URIS.has(uri);
      const protocol = http ? 'HTTP/1.1' : 'RTSP/1.0';
      const sequence = http ? undefined : ++this.cseq;
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`RAOP ${method} timeout`)), timeout);
      const abort = () => finish(new Error('RAOP aborted'));
      const finish = (error?: Error, response?: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = undefined;
        if (error) {
          if (sequence === undefined) this.socket.destroy(); // Anonymous HTTP replies cannot be safely reused after cancellation.
          else {
            this.abandoned.add(sequence);
            if (this.abandoned.size > 64) this.abandoned.delete(this.abandoned.values().next().value!);
          }
          reject(error);
        } else if (!allowError && response!.code !== 200) reject(new Error(`RAOP ${method}: ${response!.code} ${response!.code === 401 || response!.code === 403 ? '(authentication rejected)' : ''}`));
        else resolve(response!);
      };
      this.pending = { sequence, protocol, resolve: response => finish(undefined, response), reject: error => finish(error) };
      signal?.addEventListener('abort', abort, { once: true });
      const controlHeaders = http ? 'User-Agent: AirPlay/320.20\r\n' :
        `CSeq: ${sequence}\r\nUser-Agent: AirPlay/550.10\r\nDACP-ID: ${this.senderId}\r\nClient-Instance: ${this.senderId}\r\nActive-Remote: ${this.activeRemote}\r\n`;
      const message = `${method} ${uri} ${protocol}\r\n${controlHeaders}${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}Content-Length: ${body.length}\r\n\r\n`;
      try {
        const wire = Buffer.concat([Buffer.from(message), body]);
        const sealed = this.cipher?.encrypt(wire);
        if (sealed) wire.fill(0); // Encrypted bodies may carry keys (the AirPlay 2 stream SETUP's shk).
        this.socket.write(sealed ?? wire, error => { if (error) finish(error); });
      } catch (error) { finish(error as Error); }
    }));
    this.queue = request.catch(() => undefined);
    return request;
  }
  /** Retry exactly the first legacy ANNOUNCE after its single supported Digest challenge. */
  async requestLegacyAnnounce(headers: Record<string, string>, body: Buffer, password: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.request('ANNOUNCE', headers, body, signal, 5000, this.uri, true);
    if (response.code !== 401) {
      if (response.code !== 200) throw new Error(`RAOP ANNOUNCE: ${response.code}`);
      return response;
    }
    if (response.wwwAuthenticate.length !== 1) throw new Error('Ambiguous RAOP authentication challenge');
    const authorization = legacyDigestAuthorization(parseLegacyDigestChallenge(response.wwwAuthenticate[0]!), 'ANNOUNCE', this.uri, password);
    return this.request('ANNOUNCE', { ...headers, Authorization: authorization }, body, signal);
  }
}

/** Explicit endpoint plus _raop._tcp TXT capabilities; no discovery or credential access. */
export class RaopStream {
  /** `airplay2` when features bit 38 (unified media control) or 48 (CoreUtils pairing) is set, else `legacy`. */
  private readonly profile: 'legacy' | 'airplay2';
  private readonly requiresLegacySeed: boolean;
  private readonly requiresPassword: boolean;
  /** md capabilities captured at construction; later caller mutations of the TXT record are ignored. */
  private readonly textMetadata: boolean;
  private readonly artworkMetadata: boolean;
  private readonly progressMetadata: boolean;
  private active = false;
  private used = false;
  private client?: RtspClient;
  private cancellation?: AbortController;
  private session?: string;
  private sequence = randomBytes(2).readUInt16BE();
  private timestamp = 66150;
  private readonly ssrc = randomBytes(4).readUInt32BE();
  constructor(private address: string, private port: number, txt: Readonly<Record<string, string>>) {
    if (!isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected IPv4 RAOP address and valid port');
    const has = (name: string, value: string) => txt[name]?.split(',').map(item => item.trim()).includes(value);
    this.textMetadata = !!has('md', '0');
    this.artworkMetadata = !!has('md', '1');
    this.progressMetadata = !!has('md', '2');
    const rawFeatures = txt.ft ?? txt.features ?? '0x0';
    const features = /^0x([\da-f]{1,8})(?:,0x([\da-f]{1,8}))?$/i.exec(rawFeatures);
    const flags = [txt.sf ?? '0x0', txt.flags ?? '0x0'];
    if (!features || flags.some(value => !/^(?:0x)?[\da-f]{1,8}$/i.test(value))) throw new Error('Unsupported RAOP receiver flags');
    const status = flags.reduce((value, flag) => value | Number.parseInt(flag, 16), 0);
    const featureBits = BigInt('0x' + features[1]) | (BigInt('0x' + (features[2] ?? '0')) << 32n);
    this.profile = featureBits & ((1n << 38n) | (1n << 48n)) ? 'airplay2' : 'legacy';
    // Access-control modes remain unsupported. Legacy Digest authentication is only evidenced by pw and bit 0x80.
    this.requiresPassword = (txt.pw !== undefined && txt.pw !== 'false') || !!(status & 0x80);
    if (txt.act === '2' || txt.acl === '1') {
      throw new Error('Unsupported RAOP receiver: access control required');
    }
    // Legacy-only rules. Apple TVs advertise flags=0x244 (includes 0x200), so the PIN rule must not apply to AirPlay 2.
    this.requiresLegacySeed = this.profile === 'legacy' && !!(status & 0x208);
    // Bits 40 (buffered audio) and 43 (system pairing) without 38/48 need setup legacy RAOP cannot do.
    const modernOnly = featureBits & ((1n << 40n) | (1n << 43n));
    if (this.profile === 'legacy' && (!has('cn', '0') || !has('et', '0') || !has('tp', 'UDP') || txt.sr !== '44100' || txt.ss !== '16' || txt.ch !== '2' || modernOnly)) {
      throw new Error('Unsupported RAOP receiver: requires legacy UDP unencrypted PCM16 stereo 44100 Hz');
    }
  }
  /**
   * Own a finite PCM16LE stereo source after synchronous validation. Streamed chunks must be
   * nonempty Buffers <= 65536 bytes; only total EOF length must align to four-byte stereo frames.
   * Pulls follow packet pacing. Destroy Readables/request iterator return on exit; arbitrary
   * producer next/return promises are observed, not awaited after cancellation.
   * Resolves after the silence latency tail and bounded best-effort teardown.
   */
  async stream(pcm: RaopPcmSource, options: RaopStreamOptions = {}): Promise<void> {
    if (options.password !== undefined && (typeof options.password !== 'string' || options.password.length === 0)) throw new Error('RAOP password must be a non-empty string');
    if (this.profile === 'airplay2' && options.password !== undefined) throw new Error('RAOP password is only supported by legacy receivers');
    if (this.profile === 'airplay2' && this.requiresPassword) throw new Error('Unsupported AirPlay 2 RAOP receiver: password authentication is not supported');
    if (this.requiresPassword && options.password === undefined) throw new Error('RAOP receiver requires a password');
    if (Buffer.isBuffer(pcm) ? pcm.length === 0 || pcm.length % 4 : !pcm || typeof pcm[Symbol.asyncIterator] !== 'function') throw new Error('Expected non-empty complete PCM16 stereo frames or an async Buffer source');
    if (options.volume !== undefined) this.volumeBody(options.volume);
    if (options.metadata) {
      this.metadataBody(options.metadata);
      if (options.metadata.artwork !== undefined) this.artworkBody(options.metadata.artwork);
    }
    if (options.duration !== undefined) this.progressBody(options.duration);
    if (this.profile === 'airplay2' && !options.credentials) throw new Error('AirPlay 2 RAOP receiver requires HAP credentials');
    if (this.profile === 'airplay2' && options.legacySeed !== undefined) throw new Error('RAOP legacy seed is not used by AirPlay 2 receivers');
    if (this.profile === 'legacy' && options.credentials !== undefined) throw new Error('HAP credentials are not used by legacy RAOP receivers');
    if (this.requiresLegacySeed && !options.legacySeed) throw new Error('RAOP receiver requires a previously paired legacy seed');
    if (options.legacySeed !== undefined && (!Buffer.isBuffer(options.legacySeed) || options.legacySeed.length !== 32)) throw new Error('RAOP legacy seed must contain 32 bytes');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('RAOP signal must be an AbortSignal');
    if (options.signal?.aborted) throw new Error('RAOP aborted');
    if (this.used) throw new Error('RAOP stream is one-shot');
    this.used = true;
    const legacySeed = options.legacySeed ? Buffer.from(options.legacySeed) : undefined;
    const controller = new AbortController(); this.cancellation = controller;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const sockets: DatagramSocket[] = [];
    const history = new PacketHistory();
    let syncTimer: ReturnType<typeof setInterval> | undefined;
    let feedbackTimer: ReturnType<typeof setInterval> | undefined;
    let airplay2: AirPlay2Audio | undefined;
    const fail = (error: Error) => controller.abort(error);
    let iterator: AsyncIterator<Buffer> | undefined;
    let chunk = Buffer.isBuffer(pcm) ? pcm : Buffer.alloc(0);
    let offset = 0; let ended = false; let totalBytes = 0;
    const readable = pcm instanceof Readable ? pcm : undefined;
    readable?.on('error', fail);
    // Pull one bounded chunk at a time; pacing the consumer applies backpressure.
    const readPacket = async (): Promise<Buffer | undefined> => {
      const packet = Buffer.alloc(PACKET_BYTES); let filled = 0;
      while (filled < PACKET_BYTES) {
        controller.signal.throwIfAborted();
        if (offset === chunk.length) {
          if (!iterator || ended) break;
          const next = await new Promise<IteratorResult<Buffer>>((resolve, reject) => {
            const finish = () => controller.signal.removeEventListener('abort', aborted);
            const aborted = () => { finish(); reject(controller.signal.reason); };
            controller.signal.addEventListener('abort', aborted, { once: true });
            Promise.resolve().then(() => { controller.signal.throwIfAborted(); return iterator!.next(); })
              .then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
          });
          controller.signal.throwIfAborted();
          if (next.done) { ended = true; break; }
          if (!Buffer.isBuffer(next.value)) throw new Error('PCM source chunks must be Buffers');
          if (next.value.length > 65536) throw new Error('PCM source chunks must not exceed 65536 bytes');
          chunk = Buffer.from(next.value); offset = 0;
          if (chunk.length === 0) throw new Error('PCM source chunks must be non-empty');
        }
        const bytes = Math.min(chunk.length - offset, PACKET_BYTES - filled);
        chunk.copy(packet, filled, offset, offset + bytes); offset += bytes; filled += bytes; totalBytes += bytes;
      }
      if (!filled && !totalBytes) throw new Error('Expected non-empty PCM source');
      if (filled % 4) throw new Error('Expected complete PCM16 stereo frames at source EOF');
      return filled ? packet.subarray(0, filled) : undefined;
    };
    try {
      if (readable) {
        readable.pause();
        iterator = { next: () => new Promise<IteratorResult<Buffer>>((resolve, reject) => {
          const cleanup = () => {
            readable.removeListener('readable', read); readable.removeListener('end', end);
            readable.removeListener('error', error); readable.removeListener('close', closed);
            controller.signal.removeEventListener('abort', aborted);
          };
          const end = () => { cleanup(); resolve({ done: true, value: undefined }); };
          const error = (reason: Error) => { cleanup(); reject(reason); };
          const closed = () => readable.readableEnded ? end() : error(new Error('PCM source closed before EOF'));
          const aborted = () => { cleanup(); reject(controller.signal.reason); };
          const read = () => {
            try {
              controller.signal.throwIfAborted();
              if (readable.errored) { error(readable.errored); return; }
              if (readable.readableEnded) { end(); return; }
              if (readable.destroyed) { closed(); return; }
              // read(0) asks for data without draining Node's entire buffered input.
              readable.read(0);
              const value = readable.read(readable.readableObjectMode ? undefined : Math.min(65536, readable.readableLength));
              if (value !== null) { cleanup(); resolve({ done: false, value }); }
            } catch (reason) { cleanup(); reject(reason); }
          };
          readable.on('readable', read); readable.once('end', end); readable.once('error', error); readable.once('close', closed);
          controller.signal.addEventListener('abort', aborted, { once: true }); read();
        }) };
      } else if (!Buffer.isBuffer(pcm)) iterator = pcm[Symbol.asyncIterator]();
      let payload = await readPacket();
      controller.signal.throwIfAborted();
      const client = new RtspClient(await connectSocket(this.address, this.port, 5000, controller.signal), fail); this.client = client;
      const bind = async () => {
        controller.signal.throwIfAborted();
        const socket = createSocket('udp4'); sockets.push(socket); socket.on('error', fail);
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { cleanup(); reject(new Error('RAOP aborted')); };
          const error = (error: Error) => { cleanup(); reject(error); };
          const cleanup = () => { controller.signal.removeEventListener('abort', aborted); socket.removeListener('error', error); };
          controller.signal.addEventListener('abort', aborted, { once: true }); socket.once('error', error);
          socket.bind(0, client.socket.localAddress, () => { cleanup(); resolve(); });
        });
        return socket;
      };
      const control = await bind(); const timing = await bind(); const audio = await bind();
      client.setLocalUri(this.ssrc);
      if (legacySeed) {
        // Legacy verification proves the client key only and does not enable HAP transport encryption.
        await verifyLegacyPairing({
          post: async (path, body) => (await client.request('POST', {
            'Content-Type': 'application/octet-stream', Connection: 'keep-alive',
          }, body, controller.signal, 5000, path)).body,
        }, legacySeed);
      }
      let serverPort: number; let controlPort: number;
      // 0 until a legacy SETUP names one: any receiver port may ask for timing.
      let timingPort = 0;
      // One wall-clock sample anchors every session NTP timestamp to monotonic time.
      const clockStart = performance.now(); const clockEpoch = Date.now();
      const ntpMilliseconds = () => clockEpoch + performance.now() - clockStart;
      // Answer timing before SETUP: AirPlay 2 receivers query the timing port before replying to the base SETUP.
      timing.on('message', (request, remote) => {
        if (controller.signal.aborted || remote.address !== this.address || (timingPort !== 0 && remote.port !== timingPort)) return;
        const received = ntpMilliseconds(); const response = timingReply(request, received, ntpMilliseconds());
        if (response) timing.send(response, remote.port, remote.address, () => {});
      });
      if (this.profile === 'airplay2') {
        airplay2 = await setupAirPlay2Audio(client, this.address, options.credentials!, this.ssrc,
          { timing: timing.address().port, control: control.address().port }, controller.signal);
        // Receivers may omit Session in this profile; '0' is sent instead, as the reference does (unverified on hardware).
        if (airplay2.session !== undefined && !/^[\w.-]+$/.test(airplay2.session)) throw new Error('Invalid RAOP session');
        this.session = airplay2.session ?? '0';
        serverPort = airplay2.serverPort; controlPort = airplay2.controlPort;
      } else {
        const sdp = `v=0\r\no=iTunes ${this.ssrc} 0 IN IP4 ${client.socket.localAddress}\r\ns=iTunes\r\nc=IN IP4 ${this.address}\r\nt=0 0\r\nm=audio 0 RTP/AVP 96\r\na=rtpmap:96 L16/44100/2\r\na=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n`;
        if (this.requiresPassword) await client.requestLegacyAnnounce({ 'Content-Type': 'application/sdp' }, Buffer.from(sdp), options.password!, controller.signal);
        else await client.request('ANNOUNCE', { 'Content-Type': 'application/sdp' }, Buffer.from(sdp), controller.signal);
        const setup = await client.request('SETUP', { Transport: `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=${control.address().port};timing_port=${timing.address().port}` }, undefined, controller.signal);
        const session = setup.headers.session?.split(';')[0];
        if (!session || !/^[\w.-]+$/.test(session)) throw new Error('Invalid RAOP session');
        this.session = session;
        const transport = setup.headers.transport ?? '';
        if (!transport.startsWith('RTP/AVP/UDP;') || !transport.split(';').includes('unicast')) throw new Error('Unsupported RAOP transport');
        const parameters = new Map(transport.split(';').map(item => { const [name, value] = item.trim().split('='); return [name, value]; }));
        const remotePort = (name: string) => {
          const value = parameters.get(name) ?? '';
          if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid RAOP ${name}`);
          return Number(value);
        };
        serverPort = remotePort('server_port'); controlPort = remotePort('control_port');
        // An omitted or explicit timing_port=0 is treated as 0; then any receiver port may ask for timing.
        timingPort = parameters.has('timing_port') && parameters.get('timing_port') !== '0' ? remotePort('timing_port') : 0;
      }
      let resendWindow = performance.now(); let resendBudget = 100;
      control.on('message', (request, remote) => {
        if (controller.signal.aborted || remote.address !== this.address || remote.port !== controlPort) return;
        if (performance.now() - resendWindow >= 1000) { resendWindow = performance.now(); resendBudget = 100; }
        const packets = history.resend(request, resendBudget);
        resendBudget -= packets.length;
        for (const packet of packets) control.send(packet, remote.port, remote.address, () => {});
      });
      const headers = { Session: this.session, 'RTP-Info': `seq=${this.sequence};rtptime=${this.timestamp}` };
      if (options.duration !== undefined) await this.setProgress(options.duration, headers);
      if (options.metadata?.artwork !== undefined) await this.setArtwork(options.metadata.artwork, headers);
      const record = await client.request('RECORD', { ...headers, Range: 'npt=0-' }, undefined, controller.signal);
      // Legacy accepts only the fixed 66150-frame latency. AirPlay 2 receivers choose their own; it is accepted
      // while the 66150-frame send schedule is kept (unverified on hardware).
      if (this.profile === 'legacy' && record.headers['audio-latency'] !== undefined && record.headers['audio-latency'] !== '66150') throw new Error('Unsupported RAOP audio latency');
      await client.request('FLUSH', headers, undefined, controller.signal);
      this.active = true;
      if (options.volume !== undefined) await this.setVolume(options.volume);
      if (options.metadata && (options.metadata.title !== undefined || options.metadata.artist !== undefined || options.metadata.album !== undefined)) {
        await this.setMetadata({ title: options.metadata.title, artist: options.metadata.artist, album: options.metadata.album });
      }
      // Legacy: probe /feedback, then repeat every 25 seconds only if supported. AirPlay 2: send now and
      // every 2 seconds without a probe. The reference starts feedback just before RECORD without waiting;
      // requests here are serialized, so feedback first would hold RECORD up to 5 s on a receiver ignoring
      // it. A failed periodic request is logged and playback continues (at most one in flight); transport
      // loss and malformed replies still fail the stream through the client's onFailure path.
      const feedback = () => client.request('POST', {}, undefined, controller.signal, 5000, '/feedback', true);
      let pending = false;
      const tick = () => {
        if (pending || controller.signal.aborted) return;
        pending = true;
        void feedback().catch(error => { if (!controller.signal.aborted) console.error(`[RAOP] feedback failed: ${(error as Error).message}`); }).finally(() => { pending = false; });
      };
      if (this.profile === 'airplay2') { tick(); feedbackTimer = setInterval(tick, 2000); }
      else if ((await feedback()).code === 200) feedbackTimer = setInterval(tick, 25000);
      let start = performance.now(); let epoch = ntpMilliseconds(); let sentFrames = 0; let firstSync = true;
      const sync = () => {
        if (controller.signal.aborted) return;
        control.send(syncPacket(this.timestamp, 66150, epoch + sentFrames / SAMPLE_RATE * 1000, firstSync), controlPort, this.address, error => { if (error) fail(error); });
        firstSync = false;
      };
      sync(); syncTimer = setInterval(sync, 1000);
      let tail = Math.ceil(66150 / FRAMES_PER_PACKET);
      let counter = 0n; // AirPlay 2 per-stream nonce counter, one value per audio packet.
      while (payload || tail > 0) {
        const wait = start + sentFrames / SAMPLE_RATE * 1000 - performance.now();
        if (wait > 0) await delay(wait, undefined, { signal: controller.signal });
        controller.signal.throwIfAborted();
        // After a stall (GC, slow source), skip the lost time rather than flood the receiver or abort.
        const lag = performance.now() - (start + sentFrames / SAMPLE_RATE * 1000);
        if (lag > 100) { start += lag; epoch += lag; sync(); }
        const plain = audioPacket(payload ?? Buffer.alloc(0), this.sequence, this.timestamp, this.ssrc, sentFrames === 0);
        const packet = airplay2 ? sealAudioPacket(plain, airplay2.audioKey, counter++) : plain;
        await new Promise<void>((resolve, reject) => audio.send(packet, serverPort, this.address, error => error ? reject(error) : resolve()));
        history.add(packet); this.sequence = (this.sequence + 1) & 0xffff; this.timestamp = (this.timestamp + FRAMES_PER_PACKET) >>> 0; sentFrames += FRAMES_PER_PACKET;
        if (payload) payload = await readPacket(); else tail--;
      }
      await delay(Math.max(0, start + sentFrames / SAMPLE_RATE * 1000 - performance.now()), undefined, { signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      this.active = false;
      controller.abort(new Error('RAOP session ending'));
      legacySeed?.fill(0);
      chunk = Buffer.alloc(0);
      readable?.destroy();
      // Arbitrary iterators may never settle return() while next() is pending.
      // Request cleanup without allowing producer code to block socket teardown.
      try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Preserve playback failure. */ }
      if (readable) {
        if (readable.closed) readable.removeListener('error', fail);
        else readable.once('close', () => readable.removeListener('error', fail));
      }
      if (syncTimer) clearInterval(syncTimer);
      if (feedbackTimer) clearInterval(feedbackTimer);
      history.clear(); options.signal?.removeEventListener('abort', abort);
      // Bounded best-effort teardown must not obscure the original playback failure.
      if (this.session && this.client && !this.client.socket.destroyed) {
        try { await this.client.request('TEARDOWN', { Session: this.session }, undefined, undefined, 500); } catch { /* Receiver may already have disconnected. */ }
      }
      // Destroy RTSP before the event channel: its close handler would otherwise fail the stream again.
      this.client?.socket.destroy(); this.client = undefined; this.session = undefined;
      airplay2?.events.destroy(); airplay2?.audioKey.fill(0);
      for (const socket of sockets) { try { socket.close(); } catch { /* Bind may have failed before the socket opened. */ } }
      this.cancellation = undefined;
    }
  }
  private volumeBody(volume: number): Buffer {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('RAOP volume must be between 0 and 100');
    return Buffer.from(`volume: ${volume === 0 ? -144 : Number((-30 + volume * 0.3).toFixed(2))}\r\n`);
  }
  private metadataBody(metadata: RaopMetadata): Buffer {
    if (metadata.title === undefined && metadata.artist === undefined && metadata.album === undefined) return Buffer.alloc(0);
    if (!this.textMetadata) throw new Error('Receiver does not support RAOP text metadata');
    const tags: Buffer[] = [];
    for (const [tag, value] of [['minm', metadata.title], ['asal', metadata.album], ['asar', metadata.artist]]) {
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new Error('RAOP metadata must be text');
      const text = Buffer.from(value); if (text.length > 4096) throw new Error('RAOP metadata too long');
      tags.push(encodeDmap(tag!, text));
    }
    return encodeDmap('mlit', Buffer.concat(tags));
  }
  private artworkBody(artwork: Buffer): Buffer {
    if (!this.artworkMetadata) throw new Error('Receiver does not support RAOP artwork metadata');
    if (!Buffer.isBuffer(artwork) || artwork.length < 3 || artwork.length > 1024 * 1024 ||
      artwork[0] !== 0xff || artwork[1] !== 0xd8 || artwork[2] !== 0xff) throw new Error('RAOP artwork must be a JPEG no larger than 1 MiB');
    return artwork;
  }
  private progressBody(duration: number): Buffer {
    if (!this.progressMetadata) throw new Error('Receiver does not support RAOP progress metadata');
    const frames = Math.round(duration * SAMPLE_RATE);
    if (!Number.isFinite(duration) || duration < 0 || !Number.isSafeInteger(frames) || frames > Number.MAX_SAFE_INTEGER - 0xffffffff) {
      throw new Error('RAOP duration must have a safely representable non-negative frame count');
    }
    const start = this.timestamp;
    const end = (start + frames) % 0x1_0000_0000;
    return Buffer.from(`progress: ${start}/${start}/${end}\r\n`);
  }
  /** Update volume only during active playback. */
  async setVolume(volume: number): Promise<void> {
    const body = this.volumeBody(volume);
    if (!this.active || !this.client) throw new Error('No active RAOP stream');
    await this.client.request('SET_PARAMETER', { Session: this.session!, 'Content-Type': 'text/parameters' }, body, this.cancellation!.signal);
  }
  /** Send supported title/album/artist tags and/or JPEG artwork associated with the current RTP position. */
  async setMetadata(metadata: RaopMetadata): Promise<void> {
    const body = this.metadataBody(metadata);
    const artwork = metadata.artwork === undefined ? undefined : this.artworkBody(metadata.artwork);
    if (!this.active || !this.client) throw new Error('No active RAOP stream');
    const headers = { Session: this.session!, 'RTP-Info': `seq=${this.sequence};rtptime=${this.timestamp}` };
    if (body.length) await this.client.request('SET_PARAMETER', { ...headers, 'Content-Type': 'application/x-dmap-tagged' }, body, this.cancellation!.signal);
    if (artwork !== undefined) await this.setArtwork(artwork, headers);
  }
  private async setArtwork(artwork: Buffer, headers?: Record<string, string>): Promise<void> {
    const body = this.artworkBody(artwork);
    if (!this.client) throw new Error('No active RAOP stream');
    await this.client.request('SET_PARAMETER', { ...(headers ?? { Session: this.session!, 'RTP-Info': `seq=${this.sequence};rtptime=${this.timestamp}` }), 'Content-Type': 'image/jpeg' }, body, this.cancellation!.signal);
  }
  private async setProgress(duration: number, headers?: Record<string, string>): Promise<void> {
    const body = this.progressBody(duration);
    if (!this.client) throw new Error('No active RAOP stream');
    await this.client.request('SET_PARAMETER', { ...(headers ?? { Session: this.session!, 'RTP-Info': `seq=${this.sequence};rtptime=${this.timestamp}` }), 'Content-Type': 'text/parameters' }, body, this.cancellation!.signal);
  }
}
