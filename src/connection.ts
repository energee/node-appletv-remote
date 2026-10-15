/**
 * AirPlay 2 remote-control connection to an Apple TV: pair-verify on the AirPlay port,
 * encrypted RTSP SETUP/RECORD, the reverse event channel, and the DataStream data channel
 * that tunnels MRP protobuf messages. Used by the MRP layer to send commands and receive updates.
 */

import { Socket } from 'node:net';
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  diffieHellman,
  sign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
} from 'node:crypto';
import { MRPConnection } from './mrp/connection.js';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { HAPSession } from './util/hap-session.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20, X25519_SPKI_PREFIX, ED25519_SPKI_PREFIX, ED25519_PKCS8_PREFIX } from './util/crypto.js';
import { TlvTag, tlvEncode, tlvDecode } from './util/tlv.js';
import { MRPMessage, MessageType } from './mrp/messages.js';
import { buildDataStreamFrame, buildDataStreamReply, parseDataStreamFrame } from './util/data-stream.js';
import type { HAPCredentials } from './auth/types.js';

/** `clientTypeUUID` that asks the receiver for an MRP data stream (stream type 130). */
const DATA_CHANNEL_TYPE_UUID = '1910A70F-DBC0-4242-AF95-115DB30604E1';
/** DER prefixes that wrap raw 32-byte X25519/Ed25519 keys for Node's `createPublicKey`/`createPrivateKey`. */

/** An HTTP/RTSP message split out of a byte buffer by `parseHTTPMessage`. */
export interface ParsedHTTP {
  startLine: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Bytes consumed from the input (headers + body). */
  totalSize: number;
}

/**
 * Bracket an IPv6 literal for a URL authority or Host header; IPv4 and names pass through.
 * In URIs the zone separator is percent-encoded (`fe80::1%25en0`); Host headers keep it raw.
 */
export function hostForURL(host: string, encodeZone = true): string {
  return host.includes(':') ? `[${encodeZone ? host.replace('%', '%25') : host}]` : host;
}

/**
 * Parse one HTTP or RTSP message (request or response) from the start of a buffer.
 * Header names are lower-cased; startLine preserves the request method or response status. Returns null until the headers
 * and `Content-Length` bytes of body have all arrived. Invalid lengths, headers over 64 KiB and bodies over
 * `maxBody` (default 16 MiB) throw a protocol error.
 */
export function parseHTTPMessage(buf: Buffer, maxBody = 16 * 1024 * 1024): ParsedHTTP | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    if (buf.length > 65536) throw new Error('HTTP header size limit exceeded');
    return null;
  }
  if (headerEnd > 65536) throw new Error('HTTP header size limit exceeded');

  const headerSection = buf.subarray(0, headerEnd).toString('utf-8');
  const headers: Record<string, string> = {};
  const lines = headerSection.split('\r\n');
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      const name = lines[i].substring(0, colonIdx).trim().toLowerCase();
      if ((name === 'content-length' || name === 'transfer-encoding') && Object.hasOwn(headers, name)) throw new Error('Duplicate framing header');
      if (name === 'transfer-encoding') throw new Error('Unsupported Transfer-Encoding');
      headers[name] = lines[i].substring(colonIdx + 1).trim();
    }
  }

  const bodyStart = headerEnd + 4;
  const length = headers['content-length'] ?? '0';
  const contentLength = Number(length);
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(contentLength) || !Number.isSafeInteger(bodyStart + contentLength)) {
    throw new Error('Invalid Content-Length');
  }
  if (contentLength > maxBody) throw new Error('HTTP body size limit exceeded');
  const totalSize = bodyStart + contentLength;
  if (buf.length < totalSize) return null;

  const body = buf.subarray(bodyStart, bodyStart + contentLength);
  return { startLine: lines[0], headers, body: Buffer.from(body), totalSize };
}

/**
 * Open a TCP socket to host:port with Nagle disabled.
 * An optional signal cancels TCP setup and destroys the pending socket.
 * @throws (rejects) on cancellation, the first socket error, or the `timeoutMs` deadline (default 5 s).
 */
export function connectSocket(host: string, port: number, timeoutMs = 5000, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const abort = (): void => { sock.destroy(); reject(new Error('Connection closed during setup')); };
    const cleanup = (): void => { sock.setTimeout(0); signal?.removeEventListener('abort', abort); };
    // Keep an error listener until the caller installs its transport watcher.
    sock.on('error', err => { cleanup(); reject(err); });
    sock.once('close', cleanup);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    sock.setNoDelay(true);
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`Connect to ${host}:${port} timed out`)));
    sock.connect(port, host, () => {
      cleanup();
      if (signal?.aborted) { abort(); return; }
      resolve(sock);
    });
  });
}

/**
 * Owns the three AirPlay sockets (RTSP control, event, data) and their HAP sessions.
 *
 * Events: `mrp-message` (every decoded MRP message from the data channel), `close` and
 * `error` (from any transport channel, emitted only when observed). `rtsp-response` is internal plumbing for `sendRTSP`.
 * Progress is logged to stderr with an `[AirPlay]` prefix.
 */
export class AirPlayConnection extends MRPConnection {
  private socket?: Socket;
  private eventSocket?: Socket;
  private dataSocket?: Socket;
  private session?: HAPSession;
  private eventSession?: HAPSession;
  private dataSession?: HAPSession;
  private rawBuffer = Buffer.alloc(0);
  private cseq = 0;
  private sharedSecret?: Buffer;
  private sessionId = String(Math.floor(Math.random() * 0xffffffff));
  private dacpId = randomBytes(8).toString('hex');
  private activeRemote = String(Math.floor(Math.random() * 0xffffffff));
  private localAddress?: string;
  private pendingRawResponse?: {
    resolve: (buf: Buffer) => void;
    reject: (err: Error) => void;
  };
  private feedbackInFlight = false;
  private connecting = false;
  private setupAbort?: AbortController;
  private pendingRTSP = new Map<string, (err: Error) => void>();
  private feedbackInterval?: ReturnType<typeof setInterval>;
  private dataDecBuffer = Buffer.alloc(0);


  constructor(
    private host: string,
    private port: number,
    credentials: HAPCredentials,
    /** Pause after the MRP handshake before resolving connect(); see ConnectOptions.settleMs. */
    settleMs = 0,
  ) {
    super(credentials, settleMs);
  }

  /**
   * Run the full setup sequence: TCP connect, pair-verify, event-channel SETUP, RECORD,
   * start the FEEDBACK heartbeat, then data-channel SETUP and the MRP handshake.
   * Concurrent connect calls reject. After close, await the old setup before reusing this instance.
   * @throws if any step fails or close() cancels setup (including the pending TCP connect).
   */
  async connect(): Promise<void> {
    if (this.connecting || this.socket) throw new Error('AirPlay already connected');
    this.connecting = true;
    this.setupAbort = new AbortController();
    this.closed = false;
    try {
      // Step 1: Open TCP connection
      this.log('opening TCP connection...');
      const socket = await connectSocket(this.host, this.port, 5000, this.setupAbort.signal);
      if (this.closed) { socket.destroy(); throw new Error('Connection closed during setup'); }
      this.socket = socket;
      this.localAddress = this.socket.localAddress;
      this.log(`TCP connected (local ${this.localAddress})`);

      // Initially handle raw (unencrypted) data for pair-verify
      this.socket.on('data', (data: Buffer) => this.onRawData(data));
      this.watchSocket(this.socket);

      // Step 2: Pair-verify on this connection
      this.log('pair-verify...');
      const { outputKey, inputKey, sharedSecret } = await this.pairVerifyOnSocket();
      if (this.closed) throw new Error('Connection closed during setup');
      this.session = new HAPSession(outputKey, inputKey);
      this.sharedSecret = sharedSecret;
      this.log('pair-verify OK');

      // Switch from raw mode to encrypted RTSP mode
      this.socket.removeAllListeners('data');
      this.socket.on('data', (data: Buffer) => this.onEncryptedData(data));

      // Step 3: Set up event channel via RTSP SETUP
      this.log('SETUP event channel...');
      await this.setupEventChannel();
      this.log('event channel OK');

      // Step 4: RECORD
      this.log('RECORD...');
      await this.sendRTSP('RECORD', this.rtspUri);
      this.log('RECORD OK');

      // Step 5: Start FEEDBACK heartbeat (every 2 seconds)
      this.startFeedbackHeartbeat();

      // Step 6: Set up data channel (MRP tunnel)
      this.log('SETUP data channel...');
      await this.setupDataChannel();
      this.log('data channel OK');
      if (this.closed) throw new Error('Connection closed during setup');
    } catch (err) {
      this.close();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  /** Write a progress line to stderr. */
  protected log(msg: string): void {
    console.error(`[AirPlay] ${msg}`);
  }

  // --- Pair-verify directly on the RTSP socket ---

  /**
   * HAP pair-verify (M1-M4) over plain HTTP on the control socket, using the stored
   * long-term keys. Returns the Control-Salt read/write keys for the RTSP session and the
   * raw X25519 shared secret, which later derives the event and data channel keys.
   * @throws on a missing M2 field, bad server signature, or an M4 error code.
   */
  private async pairVerifyOnSocket(): Promise<{
    outputKey: Buffer;
    inputKey: Buffer;
    sharedSecret: Buffer;
  }> {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const ephemeralPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );

    // M1: Send ephemeral public key
    const m1 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x01]),
      [TlvTag.PublicKey]: ephemeralPublicKeyRaw,
    });
    const m2Body = await this.httpPostOnSocket('/pair-verify', m1);
    const m2 = tlvDecode(m2Body);

    const serverEphemeralPub = m2[TlvTag.PublicKey];
    const m2Encrypted = m2[TlvTag.EncryptedData];
    if (!serverEphemeralPub || !m2Encrypted) {
      const error = m2[TlvTag.Error];
      throw new Error(`M2 missing PublicKey or EncryptedData (error=${error ? error[0] : 'none'})`);
    }

    // Compute shared secret
    const serverEphemeralKeyObj = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, serverEphemeralPub]),
      format: 'der',
      type: 'spki',
    });
    const sharedSecret = diffieHellman({ privateKey, publicKey: serverEphemeralKeyObj });

    // Derive session key
    const sessionKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Pair-Verify-Encrypt-Salt',
      'Pair-Verify-Encrypt-Info',
      32,
    );

    // Decrypt M2 encrypted data
    const m2Nonce = Buffer.alloc(12, 0);
    m2Nonce.write('PV-Msg02', 4);
    const m2Ciphertext = m2Encrypted.subarray(0, m2Encrypted.length - 16);
    const m2Tag = m2Encrypted.subarray(m2Encrypted.length - 16);
    const decrypted = decryptChaCha20(sessionKey, m2Nonce, m2Ciphertext, m2Tag, Buffer.alloc(0));
    const serverInfo = tlvDecode(decrypted);

    const serverIdentifier = serverInfo[TlvTag.Identifier];
    const serverSignature = serverInfo[TlvTag.Signature];
    if (!serverIdentifier || !serverSignature) {
      throw new Error('M2 decrypted data missing Identifier or Signature');
    }

    // Verify server signature
    const serverSignedData = Buffer.concat([serverEphemeralPub, serverIdentifier, ephemeralPublicKeyRaw]);
    const serverLTPKObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, this.credentials.serverLTPK]),
      format: 'der',
      type: 'spki',
    });
    const valid = cryptoVerify(null, serverSignedData, serverLTPKObj, serverSignature);
    if (!valid) throw new Error('Server signature verification failed');

    // Sign our proof
    const clientSignedData = Buffer.concat([
      ephemeralPublicKeyRaw,
      Buffer.from(this.credentials.clientId),
      serverEphemeralPub,
    ]);
    const clientPrivKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, this.credentials.clientLTSK]),
      format: 'der',
      type: 'pkcs8',
    });
    const clientSignature = sign(null, clientSignedData, clientPrivKey);

    // Encrypt M3
    const subTlv = tlvEncode({
      [TlvTag.Identifier]: Buffer.from(this.credentials.clientId),
      [TlvTag.Signature]: clientSignature,
    });
    const m3Nonce = Buffer.alloc(12, 0);
    m3Nonce.write('PV-Msg03', 4);
    const { ciphertext, tag } = encryptChaCha20(sessionKey, m3Nonce, subTlv, Buffer.alloc(0));

    const m3 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.EncryptedData]: Buffer.concat([ciphertext, tag]),
    });

    if (this.closed) throw new Error('Connection closed during setup');
    const m4Body = await this.httpPostOnSocket('/pair-verify', m3);
    const m4 = tlvDecode(m4Body);
    const m4Error = m4[TlvTag.Error];
    if (m4Error && m4Error[0] !== 0) {
      throw new Error(`Pair-verify M4 error: ${m4Error[0]}`);
    }

    // Derive encryption keys
    const outputKey = await hkdfSha512(
      Buffer.from(sharedSecret), 'Control-Salt', 'Control-Write-Encryption-Key', 32,
    );
    const inputKey = await hkdfSha512(
      Buffer.from(sharedSecret), 'Control-Salt', 'Control-Read-Encryption-Key', 32,
    );

    return { outputKey, inputKey, sharedSecret: Buffer.from(sharedSecret) };
  }

  /**
   * Send a plain HTTP POST on the control socket; `onRawData` resolves it with the response
   * body. Only one request may be in flight. The response status code is not checked.
   */
  private httpPostOnSocket(path: string, body: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const headers = [
        `POST ${path} HTTP/1.1`,
        `Host: ${hostForURL(this.host, false)}:${this.port}`,
        'User-Agent: AirPlay/320.20',
        'Connection: keep-alive',
        'X-Apple-HKP: 3',
        'Content-Type: application/octet-stream',
        `Content-Length: ${body.length}`,
        '',
        '',
      ].join('\r\n');

      if (!this.socket || this.closed) { reject(new Error('Connection closed')); return; }
      if (this.pendingRawResponse) { reject(new Error('HTTP request already pending')); return; }
      const timer = setTimeout(() => entry.reject(new Error('HTTP response timeout')), 5000);
      const entry = {
        resolve: (data: Buffer): void => { clearTimeout(timer); this.pendingRawResponse = undefined; resolve(data); },
        reject: (err: Error): void => { clearTimeout(timer); this.pendingRawResponse = undefined; reject(err); },
      };
      this.pendingRawResponse = entry;
      const socket = this.socket;
      try {
        socket.write(Buffer.concat([Buffer.from(headers), body]), err => { if (err && this.socket === socket) this.fail(err); });
      } catch (err) { this.fail(err); }
    });
  }

  /** Buffer unencrypted bytes during pair-verify and resolve the pending POST once a full response arrives. */
  private onRawData(data: Buffer): void {
    if (this.closed) return;
    try {
      this.rawBuffer = Buffer.concat([this.rawBuffer, data]);

      const parsed = parseHTTPMessage(this.rawBuffer);
      if (!parsed) return;

      this.rawBuffer = this.rawBuffer.subarray(parsed.totalSize);

      this.pendingRawResponse?.resolve(parsed.body);
    } catch (err) { this.fail(err); }
  }

  // --- Encrypted RTSP ---

  private encryptedBuffer: Buffer = Buffer.alloc(0);
  private rtspDecBuffer = Buffer.alloc(0);
  private pendingWrites = new Set<(err: Error) => void>();

  /**
   * Send an RTSP request (encrypted once the session exists) and resolve with the next
   * `rtsp-response` event with the same CSeq. Register before writing; time out after 5 s.
   * Transport loss rejects pending requests immediately.
   */
  private async sendRTSP(
    method: string,
    uri: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<{ headers: Record<string, string>; body: Buffer }> {
    this.cseq++;
    const allHeaders: Record<string, string> = {
      CSeq: String(this.cseq),
      'User-Agent': 'AirPlay/620.14.6',
      'DACP-ID': this.dacpId,
      'Active-Remote': this.activeRemote,
      'Client-Instance': this.dacpId,
      ...headers,
    };

    let request = `${method} ${uri} RTSP/1.0\r\n`;
    for (const [key, value] of Object.entries(allHeaders)) {
      request += `${key}: ${value}\r\n`;
    }
    if (body) {
      request += `Content-Length: ${body.length}\r\n`;
    }
    request += '\r\n';

    let data = Buffer.from(request);
    if (body) data = Buffer.concat([data, body]);

    if (this.session) {
      data = Buffer.from(this.session.encrypt(data));
    }

    const cseq = allHeaders.CSeq;
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) { reject(new Error('Connection closed')); return; }
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('rtsp-response', onResponse);
        this.pendingRTSP.delete(cseq);
      };
      const onResponse = (response: { headers: Record<string, string>; body: Buffer }): void => {
        if (response.headers.cseq !== cseq) return;
        cleanup();
        resolve(response);
      };
      const fail = (err: Error): void => { cleanup(); reject(err); };
      const timer = setTimeout(() => fail(new Error(`RTSP response timeout: ${method}`)), 5000);
      this.pendingRTSP.set(cseq, fail);
      this.on('rtsp-response', onResponse);
      const socket = this.socket;
      try { socket.write(data, err => { if (err && this.socket === socket) this.fail(err); }); }
      catch (err) { this.fail(err); }
    });
  }

  /** Session URI used for SETUP/RECORD: `rtsp://<local address>/<session id>`. */
  private get rtspUri(): string {
    return `rtsp://${hostForURL(this.localAddress ?? '')}/${this.sessionId}`;
  }

  /**
   * RTSP SETUP announcing this client as a remote-control-only sender. If the response
   * carries an `eventPort`, connect to it with Events-Salt keys and answer the receiver's
   * requests there; otherwise no event channel is opened.
   */
  private async setupEventChannel(): Promise<void> {
    const macAddress = randomBytes(6).toString('hex').match(/../g)!.join(':').toUpperCase();
    const body = bplistCreator({
      isRemoteControlOnly: true,
      timingProtocol: 'None',
      sessionUUID: randomUUID().toUpperCase(),
      deviceID: macAddress,
      macAddress: macAddress,
      model: 'iPhone14,3',
      name: 'Node ATV Remote',
      osName: 'iPhone OS',
      osVersion: '17.0',
      osBuildVersion: '21A5248v',
      sourceVersion: '550.10',
    });
    const response = await this.sendRTSP('SETUP', this.rtspUri, {
      'Content-Type': 'application/x-apple-binary-plist',
    }, body);
    // Parse eventPort from response
    let eventPort: number | undefined;
    if (response.body.length > 0) {
      try {
        const parsed = parseBuffer(response.body);
        const respObj = parsed[0] as Record<string, unknown>;
        eventPort = respObj?.eventPort as number | undefined;
      } catch {
        // ignore parse errors
      }
    }

    if (eventPort) {
      // Create HAP session for event channel with Events-Salt keys.
      // Keys are reversed because the event channel originates from the receiver.
      const eventOutputKey = await hkdfSha512(
        this.sharedSecret!, 'Events-Salt', 'Events-Read-Encryption-Key', 32,
      );
      const eventInputKey = await hkdfSha512(
        this.sharedSecret!, 'Events-Salt', 'Events-Write-Encryption-Key', 32,
      );
      if (this.closed) throw new Error('Connection closed during setup');
      this.eventSession = new HAPSession(eventOutputKey, eventInputKey);

      this.log(`connecting to event port ${eventPort}...`);
      const socket = await connectSocket(this.host, eventPort, 5000, this.setupAbort?.signal);
      if (this.closed) { socket.destroy(); throw new Error('Connection closed during setup'); }
      this.eventSocket = socket;
      this.log('event socket connected');
      this.eventSocket.on('data', (data: Buffer) => this.onEventChannelData(data));
      this.watchSocket(this.eventSocket);
    }
  }

  /**
   * RTSP SETUP for an MRP data stream, connect to the returned `dataPort` (falling back to
   * the control port), derive DataStream keys from the seed, then run the MRP handshake.
   */
  private async setupDataChannel(): Promise<void> {
    // Seed must be an integer (not Buffer) in the bplist so it encodes as uint64.
    // bplist-creator truncates values > 2^31-1, so we limit to that range.
    const seed = Math.floor(Math.random() * 0x7FFFFFFF);
    const channelID = randomUUID().toUpperCase();
    const body = bplistCreator({
      streams: [{
        type: 130,
        controlType: 2,
        channelID,
        seed,
        clientUUID: randomUUID().toUpperCase(),
        wantsDedicatedSocket: true,
        clientTypeUUID: DATA_CHANNEL_TYPE_UUID,
      }],
    });

    const response = await this.sendRTSP('SETUP', this.rtspUri, {
      'Content-Type': 'application/x-apple-binary-plist',
    }, body);

    // Parse data port from response body
    let dataPort = this.port;
    if (response.body.length > 0) {
      try {
        const parsed = parseBuffer(response.body);
        const respObj = parsed[0] as Record<string, unknown>;
        const streams = respObj?.streams as Array<Record<string, unknown>> | undefined;
        if (streams?.[0]?.dataPort) {
          dataPort = streams[0].dataPort as number;
        }
      } catch {
        // ignore parse errors
      }
    }

    // Derive data channel encryption keys via HKDF
    // Salt = "DataStream-Salt" + seed as decimal string
    const saltStr = `DataStream-Salt${seed}`;

    const dataOutputKey = await hkdfSha512(
      this.sharedSecret!,
      saltStr,
      'DataStream-Output-Encryption-Key',
      32,
    );
    const dataInputKey = await hkdfSha512(
      this.sharedSecret!,
      saltStr,
      'DataStream-Input-Encryption-Key',
      32,
    );
    if (this.closed) throw new Error('Connection closed during setup');
    this.dataSession = new HAPSession(dataOutputKey, dataInputKey);

    this.log(`connecting data channel to ${this.host}:${dataPort}...`);

    const socket = await connectSocket(this.host, dataPort, 5000, this.setupAbort?.signal);
    if (this.closed) { socket.destroy(); throw new Error('Connection closed during setup'); }
    this.dataSocket = socket;
    this.log('data socket connected');

    this.dataSocket.on('data', (data: Buffer) => this.onDataChannelData(data));
    this.watchSocket(this.dataSocket);

    // Initialize MRP protocol on data channel
    await this.initMRPProtocol();
  }

  /** Buffer encrypted control-socket bytes after pair-verify and try to extract an RTSP response. */
  private onEncryptedData(data: Buffer): void {
    if (this.closed) return;
    this.encryptedBuffer = Buffer.concat([this.encryptedBuffer, data]);
    this.tryParseRTSPResponse();
  }

  /** Decrypt complete HAP frames and drain complete RTSP messages, preserving partial plaintext. */
  private tryParseRTSPResponse(): void {
    try {
      if (this.session) {
        const { plaintext, rest } = this.session.decryptAvailable(this.encryptedBuffer);
        this.encryptedBuffer = rest;
        this.rtspDecBuffer = Buffer.concat([this.rtspDecBuffer, plaintext]);
      } else {
        this.rtspDecBuffer = Buffer.concat([this.rtspDecBuffer, this.encryptedBuffer]);
        this.encryptedBuffer = Buffer.alloc(0);
      }
      while (this.rtspDecBuffer.length && !this.closed) {
        const parsed = parseHTTPMessage(this.rtspDecBuffer);
        if (!parsed) return;
        this.rtspDecBuffer = this.rtspDecBuffer.subarray(parsed.totalSize);
        this.emit('rtsp-response', { headers: parsed.headers, body: parsed.body });
      }
    } catch (err) { this.fail(err); }
  }

  private eventEncBuffer: Buffer = Buffer.alloc(0);
  private eventDecBuffer = Buffer.alloc(0);

  /** Decrypt event-channel bytes and acknowledge any complete requests from the receiver. */
  private onEventChannelData(data: Buffer): void {
    if (this.closed || !this.eventSession) return;
    this.eventEncBuffer = Buffer.concat([this.eventEncBuffer, data]);
    try {
      const { plaintext, rest } = this.eventSession.decryptAvailable(this.eventEncBuffer);
      this.eventEncBuffer = rest;
      this.eventDecBuffer = Buffer.concat([this.eventDecBuffer, plaintext]);
    } catch (e) {
      this.fail(e);
      return;
    }

    // Parse HTTP requests from decrypted data and respond with 200 OK
    this.processEventRequests();
  }

  /** Answer each buffered event-channel request with an encrypted `RTSP/1.0 200 OK`, echoing CSeq and Server. */
  private processEventRequests(): void {
    if (this.closed || !this.eventSession) return;
    try {
      while (this.eventDecBuffer.length > 0 && !this.closed) {
        const parsed = parseHTTPMessage(this.eventDecBuffer);
        if (!parsed) break;

        this.eventDecBuffer = this.eventDecBuffer.subarray(parsed.totalSize);

        // Build 200 OK response
        const respHeaders: string[] = [
          'Content-Length: 0',
          'Audio-Latency: 0',
        ];
        if (parsed.headers['server']) respHeaders.push(`Server: ${parsed.headers['server']}`);
        if (parsed.headers['cseq']) respHeaders.push(`CSeq: ${parsed.headers['cseq']}`);

        const response = `RTSP/1.0 200 OK\r\n${respHeaders.join('\r\n')}\r\n\r\n`;
        const encrypted = this.eventSession!.encrypt(Buffer.from(response));
        const socket = this.eventSocket;
        socket?.write(encrypted, err => { if (err && this.eventSocket === socket) this.fail(err); });
      }
    } catch (err) { this.fail(err); }
  }

  private dataEncBuffer: Buffer = Buffer.alloc(0);

  /**
   * Decrypt data-channel bytes, ack every "sync" DataStream frame with a "rply", and hand
   * each protobuf payload to `handleMRPResponse`.
   */
  private onDataChannelData(data: Buffer): void {
    if (this.closed || !this.dataSession) return;
    this.dataEncBuffer = Buffer.concat([this.dataEncBuffer, data]);

    // Decrypt all complete HAP frames in one pass; one concat per chunk, not per 1 KB frame.
    try {
      const { plaintext, rest } = this.dataSession!.decryptAvailable(this.dataEncBuffer);
      this.dataEncBuffer = rest;
      this.dataDecBuffer = Buffer.concat([this.dataDecBuffer, plaintext]);
      // Parse complete DataStream frames from the decrypted buffer
      while (this.dataDecBuffer.length >= 32 && !this.closed) {
        const frame = parseDataStreamFrame(this.dataDecBuffer, 0);
        if (!frame) break;

        // Send rply for sync frames from the Apple TV
        if (frame.messageType === 'sync') {
          const reply = buildDataStreamReply(frame.seqno);
          const encrypted = this.dataSession!.encrypt(reply);
          const socket = this.dataSocket;
          socket?.write(encrypted, err => { if (err && this.dataSocket === socket) this.fail(err); });
        }

        if (frame.protobufData) {
          void this.handleMRPResponse(frame.protobufData).catch(error => {
            // EventEmitter listener exceptions must remain uncaught exceptions, not detached rejections.
            queueMicrotask(() => { throw error; });
          });
        }

        // Advance buffer past this frame
        this.dataDecBuffer = this.dataDecBuffer.subarray(frame.totalSize);
      }
    } catch (err) { this.fail(err); }
  }

  /** POST /feedback every 2 s, at most one in flight; failure terminates the transport. */
  private startFeedbackHeartbeat(): void {
    this.feedbackInterval = setInterval(async () => {
      if (this.feedbackInFlight || this.closed) return;
      this.feedbackInFlight = true;
      try {
        await this.sendRTSP('POST', '/feedback');
      } catch (e) {
        if (!this.closed) this.fail(e);
      } finally {
        this.feedbackInFlight = false;
      }
    }, 2000);
  }

  /**
   * Frame an encoded MRP message as DataStream, encrypt it, and write it to the data channel.
   * @throws if the data channel is not connected or the socket write fails.
   */
  async sendMRPMessage(protobufData: Buffer): Promise<void> {
    if (!this.dataSocket || !this.dataSession || this.closed) throw new Error('Data channel not connected');
    try {
      const frame = buildDataStreamFrame(protobufData);
      const encrypted = this.dataSession.encrypt(frame);
      await new Promise<void>((resolve, reject) => {
        const fail = (err: Error): void => { this.pendingWrites.delete(fail); reject(err); };
        this.pendingWrites.add(fail);
        try {
          const socket = this.dataSocket!;
          socket.write(encrypted, err => {
            this.pendingWrites.delete(fail);
            if (err) { if (this.dataSocket === socket) this.fail(err); reject(err); }
            else resolve();
          });
        } catch (err) {
          this.fail(err);
        }
      });
    } catch (err) {
      if (!this.closed) this.fail(err);
      throw err;
    }
  }

  /** Observe loss on any channel as loss of the whole authenticated session. */
  private watchSocket(socket: Socket): void {
    if (this.closed) { socket.destroy(); throw new Error('Connection closed during setup'); }
    const isCurrent = (): boolean => [this.socket, this.eventSocket, this.dataSocket].includes(socket);
    socket.on('error', err => { if (isCurrent()) this.fail(err); });
    socket.on('close', () => { if (isCurrent()) this.close(); });
    socket.on('end', () => { if (isCurrent()) this.close(); });
  }

  /** Clean up first; errors remain observable without requiring an EventEmitter error listener. */
  private fail(cause: unknown): void {
    if (this.closed) return;
    const err = cause instanceof Error ? cause : new Error(String(cause));
    this.close(err);
    if (this.listenerCount('error')) this.emit('error', err);
  }

  /** Cancel setup, reject pending work, and shut down locally; ignores later callbacks from old sockets.
   * Idempotent; no receiver teardown acknowledgment is awaited. Emits close even for failed setup.
   */
  close(reason = new Error('Connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.mrpGeneration++;
    this.setupAbort?.abort();
    this.feedbackInFlight = false;
    this.cseq = 0;
    if (this.feedbackInterval) clearInterval(this.feedbackInterval);
    this.feedbackInterval = undefined;
    this.pendingRawResponse?.reject(reason);
    for (const reject of this.pendingRTSP.values()) reject(reason);
    this.rejectMRPRequests(reason);
    for (const reject of this.pendingWrites) reject(reason);
    for (const socket of [this.dataSocket, this.eventSocket, this.socket]) socket?.destroy();
    this.dataSocket = this.eventSocket = this.socket = undefined;
    this.session = this.eventSession = this.dataSession = undefined;
    this.sharedSecret = undefined;
    this.rawBuffer = this.rtspDecBuffer = this.encryptedBuffer = this.eventEncBuffer = this.eventDecBuffer = this.dataEncBuffer = this.dataDecBuffer = Buffer.alloc(0);
    this.emit('close');
  }
}
