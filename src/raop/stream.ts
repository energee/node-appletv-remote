/** One-shot legacy RAOP PCM streaming; supports legacy PIN verification but not HAP/AirPlay 2 audio. */
import { createConnection, isIPv4, type Socket } from 'node:net';
import { createSocket, type Socket as DatagramSocket } from 'node:dgram';
import { randomBytes, createPrivateKey, createPublicKey, diffieHellman, createHash, createCipheriv, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { audioPacket, timingReply, syncPacket, PacketHistory, FRAMES_PER_PACKET, SAMPLE_RATE, PACKET_BYTES } from './packets.js';
import { x25519PublicKeyFromRaw, X25519_PKCS8_PREFIX, ED25519_PKCS8_PREFIX } from '../util/crypto.js';
import { parseHTTPMessage } from '../connection.js';

/** Finite raw PCM chunks; streamed chunks are Buffers of at most 65,536 bytes. */
export type RaopPcmSource = Buffer | AsyncIterable<Buffer>;

export interface RaopMetadata { title?: string; artist?: string; album?: string }
export interface RaopStreamOptions {
  /** Cancellation interrupts source reads, setup or playback and performs bounded teardown. */
  signal?: AbortSignal;
  /** Receiver volume percentage, 0 (mute) through 100 (0 dB). */
  volume?: number;
  /** Text metadata requires the receiver's md=0 advertisement. */
  metadata?: RaopMetadata;
  /** Previously paired legacy AirPlay seed (32 bytes), NOT HAP credentials. No pairing/storage access. */
  legacySeed?: Buffer;
}
interface Response { headers: Record<string, string>; code: number; body: Buffer }

/** Serialized legacy HTTP authentication and CSeq-correlated RTSP audio requests on one socket. */
class RtspClient {
  readonly socket: Socket;
  private input = Buffer.alloc(0);
  private cseq = 0;
  private abandoned = new Set<number>();
  private readonly senderId = randomBytes(8).toString('hex').toUpperCase();
  private readonly activeRemote = randomBytes(4).readUInt32BE();
  private queue: Promise<unknown> = Promise.resolve();
  private pending?: { sequence?: number; protocol: 'HTTP/1.1' | 'RTSP/1.0'; resolve: (response: Response) => void; reject: (error: Error) => void };
  constructor(host: string, port: number, private uri: string, onFailure: (error: Error) => void) {
    this.socket = createConnection({ host, port });
    this.socket.setNoDelay(true);
    this.socket.on('error', error => { this.pending?.reject(error); onFailure(error); });
    this.socket.on('close', () => { const error = new Error('RAOP control connection closed'); this.pending?.reject(error); onFailure(error); });
    this.socket.on('data', (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk]);
      try { this.parse(); } catch (error) { this.pending?.reject(error as Error); onFailure(error as Error); this.socket.destroy(); }
    });
  }
  /** Shared HTTP framing (64 KiB header and body caps); RTSP status and CSeq correlation are checked here. */
  private parse(): void {
    while (true) {
      const message = parseHTTPMessage(this.input, 65536);
      if (!message) return;
      const status = /^(RTSP\/1\.0|HTTP\/1\.1) (\d{3})(?: |$)/.exec(message.startLine);
      if (!status) throw new Error('Malformed RAOP RTSP response');
      // parseHTTPMessage keeps the last duplicate header, so a repeated CSeq is rejected from the raw header block.
      if ((this.input.subarray(0, message.totalSize - message.body.length).toString().match(/\r\ncseq:/gi)?.length ?? 0) > 1) throw new Error('Duplicate RAOP response header');
      const { headers, body } = message;
      this.input = this.input.subarray(message.totalSize);
      if (status[1] === 'RTSP/1.0' && this.abandoned.delete(Number(headers.cseq))) continue;
      if (!this.pending || status[1] !== this.pending.protocol) throw new Error('Unexpected RAOP response protocol');
      if (this.pending.sequence !== undefined && headers.cseq !== String(this.pending.sequence)) throw new Error('Unexpected RAOP CSeq');
      this.pending.resolve({ headers, code: Number(status[2]), body });
    }
  }
  setLocalUri(sessionId: number): void { this.uri = `rtsp://${this.socket.localAddress}/${sessionId}`; }
  request(method: string, headers: Record<string, string> = {}, body: Buffer = Buffer.alloc(0), signal?: AbortSignal, timeout = 5000, uri = this.uri, allowError = false): Promise<Response> {
    const request = this.queue.then(() => new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('RAOP aborted')); return; }
      if (this.socket.destroyed) { reject(new Error('RAOP control connection closed')); return; }
      const http = method === 'POST' && uri === '/pair-verify';
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
        this.socket.write(Buffer.concat([Buffer.from(message), body]), error => { if (error) finish(error); });
      } catch (error) { finish(error as Error); }
    }));
    this.queue = request.catch(() => undefined);
    return request;
  }
}

/** Explicit endpoint plus _raop._tcp TXT capabilities; no discovery or credential access. */
export class RaopStream {
  private readonly requiresLegacySeed: boolean;
  private active = false;
  private used = false;
  private client?: RtspClient;
  private cancellation?: AbortController;
  private session?: string;
  private sequence = randomBytes(2).readUInt16BE();
  private timestamp = 66150;
  private readonly ssrc = randomBytes(4).readUInt32BE();
  constructor(private address: string, private port: number, private txt: Readonly<Record<string, string>>) {
    this.txt = { ...txt };
    const has = (name: string, value: string) => txt[name]?.split(',').map(item => item.trim()).includes(value);
    if (!isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected IPv4 RAOP address and valid port');
    const rawFeatures = txt.ft ?? txt.features ?? '0x0';
    const features = /^0x([\da-f]{1,8})(?:,0x([\da-f]{1,8}))?$/i.exec(rawFeatures);
    const flags = [txt.sf ?? '0x0', txt.flags ?? '0x0'];
    if (!features || flags.some(value => !/^(?:0x)?[\da-f]{1,8}$/i.test(value))) throw new Error('Unsupported RAOP receiver flags');
    const status = flags.reduce((value, flag) => value | Number.parseInt(flag, 16), 0);
    const featureBits = BigInt('0x' + features[1]) | (BigInt('0x' + (features[2] ?? '0')) << 32n);
    this.requiresLegacySeed = !!(status & 0x208);
    // These advertisements select modern setup/encryption, not legacy PIN verification.
    const modern = featureBits & ((1n << 38n) | (1n << 40n) | (1n << 43n) | (1n << 48n));
    if (!has('cn', '0') || !has('et', '0') || !has('tp', 'UDP') || txt.sr !== '44100' || txt.ss !== '16' || txt.ch !== '2' || (txt.pw !== undefined && txt.pw !== 'false') || (status & 0x80) || modern || txt.act === '2' || txt.acl === '1') {
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
    if (Buffer.isBuffer(pcm) ? pcm.length === 0 || pcm.length % 4 : !pcm || typeof pcm[Symbol.asyncIterator] !== 'function') throw new Error('Expected non-empty complete PCM16 stereo frames or an async Buffer source');
    if (options.volume !== undefined) this.volumeBody(options.volume);
    if (options.metadata) this.metadataBody(options.metadata);
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
      const uri = `rtsp://${this.address}/${this.ssrc}`;
      const client = new RtspClient(this.address, this.port, uri, fail); this.client = client;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('RAOP connect timeout')), 5000);
        const aborted = () => finish(new Error('RAOP aborted'));
        const connected = () => finish();
        const error = (error: Error) => finish(error);
        const finish = (error?: Error) => {
          clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); client.socket.removeListener('connect', connected); client.socket.removeListener('error', errorHandler);
          if (error) reject(error); else resolve();
        };
        const errorHandler = error;
        controller.signal.addEventListener('abort', aborted, { once: true }); client.socket.once('connect', connected); client.socket.once('error', errorHandler);
        if (controller.signal.aborted) aborted();
      });
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
        // Pinned pyatv LegacySRPAuthHandler uses the seed for BOTH key types.
        // This proves the client key only and does not turn on HAP transport encryption.
        const curveDer = Buffer.concat([X25519_PKCS8_PREFIX, legacySeed]);
        const signingDer = Buffer.concat([ED25519_PKCS8_PREFIX, legacySeed]);
        let curveKey: ReturnType<typeof createPrivateKey>;
        let signingKey: ReturnType<typeof createPrivateKey>;
        try {
          curveKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: curveDer });
          signingKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: signingDer });
        } finally { curveDer.fill(0); signingDer.fill(0); legacySeed.fill(0); }
        const curvePublic = createPublicKey(curveKey).export({ format: 'der', type: 'spki' }).subarray(-32);
        const signingPublic = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).subarray(-32);
        const authHeaders = { 'Content-Type': 'application/octet-stream', Connection: 'keep-alive' };
        const response = await client.request('POST', authHeaders, Buffer.concat([Buffer.from([1, 0, 0, 0]), curvePublic, signingPublic]), controller.signal, 5000, '/pair-verify');
        if (response.body.length !== 96) throw new Error('Invalid legacy pair-verify response: expected 96 bytes');
        const receiverPublic = response.body.subarray(0, 32);
        const shared = diffieHellman({ privateKey: curveKey, publicKey: x25519PublicKeyFromRaw(receiverPublic) });
        let key: Buffer | undefined;
        let iv: Buffer | undefined;
        let signed: Buffer | undefined;
        try {
          key = createHash('sha512').update('Pair-Verify-AES-Key').update(shared).digest();
          iv = createHash('sha512').update('Pair-Verify-AES-IV').update(shared).digest();
          const cipher = createCipheriv('aes-128-ctr', key.subarray(0, 16), iv.subarray(0, 16));
          // Discard encrypted receiver data to advance the CTR stream before our signature.
          cipher.update(response.body.subarray(32));
          signed = sign(null, Buffer.concat([curvePublic, receiverPublic]), signingKey);
          const signature = cipher.update(signed);
          cipher.final();
          await client.request('POST', authHeaders, Buffer.concat([Buffer.alloc(4), signature]), controller.signal, 5000, '/pair-verify');
        } finally { shared.fill(0); key?.fill(0); iv?.fill(0); signed?.fill(0); }
      }
      const sdp = `v=0\r\no=iTunes ${this.ssrc} 0 IN IP4 ${client.socket.localAddress}\r\ns=iTunes\r\nc=IN IP4 ${this.address}\r\nt=0 0\r\nm=audio 0 RTP/AVP 96\r\na=rtpmap:96 L16/44100/2\r\na=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100\r\n`;
      await client.request('ANNOUNCE', { 'Content-Type': 'application/sdp' }, Buffer.from(sdp), controller.signal);
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
      const serverPort = remotePort('server_port'); const controlPort = remotePort('control_port');
      // pyatv AirPlayV1 defaults an omitted timing_port to 0; then any receiver port may ask for timing.
      const timingPort = parameters.has('timing_port') ? remotePort('timing_port') : 0;
      // One wall-clock sample anchors every session NTP timestamp to monotonic time.
      const clockStart = performance.now(); const clockEpoch = Date.now();
      const ntpMilliseconds = () => clockEpoch + performance.now() - clockStart;
      timing.on('message', (request, remote) => {
        if (controller.signal.aborted || remote.address !== this.address || (timingPort !== 0 && remote.port !== timingPort)) return;
        const received = ntpMilliseconds(); const response = timingReply(request, received, ntpMilliseconds());
        if (response) timing.send(response, remote.port, remote.address, () => {});
      });
      let resendWindow = performance.now(); let resendBudget = 100;
      control.on('message', (request, remote) => {
        if (controller.signal.aborted || remote.address !== this.address || remote.port !== controlPort) return;
        if (performance.now() - resendWindow >= 1000) { resendWindow = performance.now(); resendBudget = 100; }
        const packets = history.resend(request, resendBudget);
        resendBudget -= packets.length;
        for (const packet of packets) control.send(packet, remote.port, remote.address, () => {});
      });
      const headers = { Session: this.session, 'RTP-Info': `seq=${this.sequence};rtptime=${this.timestamp}` };
      const record = await client.request('RECORD', { ...headers, Range: 'npt=0-' }, undefined, controller.signal);
      // Only accept the fixed upstream legacy latency; a different negotiated latency needs a separate profile.
      if (record.headers['audio-latency'] !== undefined && record.headers['audio-latency'] !== '66150') throw new Error('Unsupported RAOP audio latency');
      await client.request('FLUSH', headers, undefined, controller.signal);
      this.active = true;
      if (options.volume !== undefined) await this.setVolume(options.volume);
      if (options.metadata) await this.setMetadata(options.metadata);
      // pyatv AirPlayV1 probes /feedback, then repeats every 25 seconds only if supported.
      // Like pyatv, a failed periodic request is logged and playback continues; transport loss
      // and malformed replies still fail the stream through the client's onFailure path.
      const feedback = () => client.request('POST', {}, undefined, controller.signal, 5000, '/feedback', true);
      if ((await feedback()).code === 200) {
        let pending = false;
        feedbackTimer = setInterval(() => {
          if (pending || controller.signal.aborted) return;
          pending = true;
          void feedback().catch(error => { if (!controller.signal.aborted) console.error(`[RAOP] feedback failed: ${(error as Error).message}`); }).finally(() => { pending = false; });
        }, 25000);
      }
      let start = performance.now(); let epoch = ntpMilliseconds(); let sentFrames = 0; let firstSync = true;
      const sync = () => {
        if (controller.signal.aborted) return;
        control.send(syncPacket(this.timestamp, 66150, epoch + sentFrames / SAMPLE_RATE * 1000, firstSync), controlPort, this.address, error => { if (error) fail(error); });
        firstSync = false;
      };
      sync(); syncTimer = setInterval(sync, 1000);
      let tail = Math.ceil(66150 / FRAMES_PER_PACKET);
      while (payload || tail > 0) {
        const wait = start + sentFrames / SAMPLE_RATE * 1000 - performance.now();
        if (wait > 0) await delay(wait, undefined, { signal: controller.signal });
        controller.signal.throwIfAborted();
        // After a stall (GC, slow source), skip the lost time rather than flood the receiver or abort.
        const lag = performance.now() - (start + sentFrames / SAMPLE_RATE * 1000);
        if (lag > 100) { start += lag; epoch += lag; sync(); }
        const packet = audioPacket(payload ?? Buffer.alloc(0), this.sequence, this.timestamp, this.ssrc, sentFrames === 0);
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
      this.client?.socket.destroy(); this.client = undefined; this.session = undefined;
      for (const socket of sockets) { try { socket.close(); } catch { /* Bind may have failed before the socket opened. */ } }
      this.cancellation = undefined;
    }
  }
  private volumeBody(volume: number): Buffer {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('RAOP volume must be between 0 and 100');
    return Buffer.from(`volume: ${volume === 0 ? -144 : Number((-30 + volume * 0.3).toFixed(2))}\r\n`);
  }
  private metadataBody(metadata: RaopMetadata): Buffer {
    if (!this.txt.md?.split(',').includes('0')) throw new Error('Receiver does not support RAOP text metadata');
    const tags: Buffer[] = [];
    for (const [tag, value] of [['minm', metadata.title], ['asal', metadata.album], ['asar', metadata.artist]]) {
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new Error('RAOP metadata must be text');
      const text = Buffer.from(value); if (text.length > 4096) throw new Error('RAOP metadata too long');
      const header = Buffer.alloc(8); header.write(tag!); header.writeUInt32BE(text.length, 4); tags.push(header, text);
    }
    const body = Buffer.concat(tags); const header = Buffer.alloc(8); header.write('mlit'); header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }
  /** Update volume only during active playback. */
  async setVolume(volume: number): Promise<void> {
    const body = this.volumeBody(volume);
    if (!this.active || !this.client) throw new Error('No active RAOP stream');
    await this.client.request('SET_PARAMETER', { Session: this.session!, 'Content-Type': 'text/parameters' }, body, this.cancellation!.signal);
  }
  /** Send supported title/album/artist tags associated with the current RTP position. */
  async setMetadata(metadata: RaopMetadata): Promise<void> {
    const body = this.metadataBody(metadata);
    if (!this.active || !this.client) throw new Error('No active RAOP stream');
    await this.client.request('SET_PARAMETER', { Session: this.session!, 'Content-Type': 'application/x-dmap-tagged', 'RTP-Info': `seq=${this.sequence};rtptime=${this.timestamp}` }, body, this.cancellation!.signal);
  }
}
