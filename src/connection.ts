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
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { HAPSession } from './util/hap-session.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from './util/crypto.js';
import { TlvTag, tlvEncode, tlvDecode } from './util/tlv.js';
import { MRPMessage, MessageType } from './mrp/messages.js';
import { buildDataStreamFrame, buildDataStreamReply, parseDataStreamFrame } from './util/data-stream.js';
import type { HAPCredentials } from './auth/types.js';

/** `clientTypeUUID` that asks the receiver for an MRP data stream (stream type 130). */
const DATA_CHANNEL_TYPE_UUID = '1910A70F-DBC0-4242-AF95-115DB30604E1';
/** DER prefixes that wrap raw 32-byte X25519/Ed25519 keys for Node's `createPublicKey`/`createPrivateKey`. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An HTTP/RTSP message split out of a byte buffer by `parseHTTPMessage`. */
interface ParsedHTTP {
  headers: Record<string, string>;
  body: Buffer;
  /** Bytes consumed from the input (headers + body). */
  totalSize: number;
}

/**
 * Parse one HTTP or RTSP message (request or response) from the start of a buffer.
 * Header names are lower-cased; the start line is ignored. Returns null until the headers
 * and `Content-Length` bytes of body have all arrived.
 */
function parseHTTPMessage(buf: Buffer): ParsedHTTP | null {
  const text = buf.toString('utf-8');
  const headerEnd = text.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  const headerSection = text.substring(0, headerEnd);
  const headers: Record<string, string> = {};
  const lines = headerSection.split('\r\n');
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      headers[lines[i].substring(0, colonIdx).trim().toLowerCase()] =
        lines[i].substring(colonIdx + 1).trim();
    }
  }

  const bodyStart = headerEnd + 4;
  const contentLength = parseInt(headers['content-length'] ?? '0', 10);
  const totalSize = bodyStart + contentLength;
  if (buf.length < totalSize) return null;

  const body = buf.subarray(bodyStart, bodyStart + contentLength);
  return { headers, body: Buffer.from(body), totalSize };
}

/**
 * Open a TCP socket to host:port with Nagle disabled.
 * @throws (rejects) on the first socket error, or if not connected within `timeoutMs` (default 5 s).
 */
export function connectSocket(host: string, port: number, timeoutMs = 5000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    // MRP/RTSP messages are small request/response writes; Nagle + delayed ACK would stall them.
    sock.setNoDelay(true);
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`Connect to ${host}:${port} timed out`)));
    sock.connect(port, host, () => {
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

/**
 * Owns the three AirPlay sockets (RTSP control, event, data) and their HAP sessions.
 *
 * Events: `mrp-message` (every decoded MRP message from the data channel), `close` and
 * `error` (from the control socket). `rtsp-response` is internal plumbing for `sendRTSP`.
 * Progress is logged to stderr with an `[AirPlay]` prefix.
 */
export class AirPlayConnection extends EventEmitter {
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
  private feedbackInterval?: ReturnType<typeof setInterval>;
  private dataDecBuffer = Buffer.alloc(0);
  private pendingMRPResolvers: Array<{
    type: number;
    resolve: (msg: Record<string, unknown>) => void;
  }> = [];

  constructor(
    private host: string,
    private port: number,
    private credentials: HAPCredentials,
  ) {
    super();
  }

  /**
   * Run the full setup sequence: TCP connect, pair-verify, event-channel SETUP, RECORD,
   * start the FEEDBACK heartbeat, then data-channel SETUP and the MRP handshake.
   * @throws if any step fails (e.g. pair-verify rejected, DeviceInfo reply timeout).
   */
  async connect(): Promise<void> {
    // Step 1: Open TCP connection
    this.log('opening TCP connection...');
    this.socket = await connectSocket(this.host, this.port);
    this.localAddress = this.socket.localAddress;
    this.log(`TCP connected (local ${this.localAddress})`);

    // Initially handle raw (unencrypted) data for pair-verify
    this.socket.on('data', (data: Buffer) => this.onRawData(data));
    this.socket.on('close', () => this.emit('close'));
    this.socket.on('error', (err) => this.emit('error', err));

    // Step 2: Pair-verify on this connection
    this.log('pair-verify...');
    const { outputKey, inputKey, sharedSecret } = await this.pairVerifyOnSocket();
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
  }

  /** Write a progress line to stderr. */
  private log(msg: string): void {
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
        `Host: ${this.host}:${this.port}`,
        'User-Agent: AirPlay/320.20',
        'Connection: keep-alive',
        'X-Apple-HKP: 3',
        'Content-Type: application/octet-stream',
        `Content-Length: ${body.length}`,
        '',
        '',
      ].join('\r\n');

      this.pendingRawResponse = { resolve, reject };
      this.socket!.write(Buffer.concat([Buffer.from(headers), body]), (err) => {
        if (err) {
          this.pendingRawResponse = undefined;
          reject(err);
        }
      });
    });
  }

  /** Buffer unencrypted bytes during pair-verify and resolve the pending POST once a full response arrives. */
  private onRawData(data: Buffer): void {
    this.rawBuffer = Buffer.concat([this.rawBuffer, data]);

    const parsed = parseHTTPMessage(this.rawBuffer);
    if (!parsed) return;

    this.rawBuffer = this.rawBuffer.subarray(parsed.totalSize);

    if (this.pendingRawResponse) {
      const { resolve } = this.pendingRawResponse;
      this.pendingRawResponse = undefined;
      resolve(parsed.body);
    }
  }

  // --- Encrypted RTSP ---

  private encryptedBuffer = Buffer.alloc(0);

  /**
   * Send an RTSP request (encrypted once the session exists) and resolve with the next
   * `rtsp-response` event. Responses are matched by arrival order, not CSeq, and there is
   * no timeout.
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

    return new Promise((resolve, reject) => {
      this.socket!.write(data, (err) => {
        if (err) reject(err);
      });
      this.once('rtsp-response', resolve);
    });
  }

  /** Session URI used for SETUP/RECORD: `rtsp://<local address>/<session id>`. */
  private get rtspUri(): string {
    return `rtsp://${this.localAddress}/${this.sessionId}`;
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
      this.eventSession = new HAPSession(eventOutputKey, eventInputKey);

      this.log(`connecting to event port ${eventPort}...`);
      this.eventSocket = await connectSocket(this.host, eventPort);
      this.log('event socket connected');
      this.eventSocket.on('data', (data: Buffer) => this.onEventChannelData(data));
      this.eventSocket.on('error', (err) => this.log(`event channel error: ${err.message}`));
      this.eventSocket.on('close', () => this.log('event channel closed'));
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
    this.dataSession = new HAPSession(dataOutputKey, dataInputKey);

    this.log(`connecting data channel to ${this.host}:${dataPort}...`);

    this.dataSocket = await connectSocket(this.host, dataPort);
    this.log('data socket connected');

    this.dataSocket.on('data', (data: Buffer) => this.onDataChannelData(data));
    this.dataSocket.on('error', (err) => this.log(`data channel error: ${err.message}`));
    this.dataSocket.on('close', () => this.log('data channel closed by remote'));
    this.dataSocket.on('end', () => this.log('data channel ended by remote'));

    // Initialize MRP protocol on data channel
    await this.initMRPProtocol();
  }

  /**
   * MRP handshake on the data channel: DeviceInfo (awaits the reply), SetConnectionState,
   * ClientUpdatesConfig, GetKeyboardSession, then an optional `ATV_SETTLE_MS` settle delay (default 0).
   * @throws if the DeviceInfo reply does not arrive within 5 s.
   */
  private async initMRPProtocol(): Promise<void> {
    this.log('sending DeviceInfo...');

    // 1. DeviceInfo must be the first message
    const deviceInfo = await MRPMessage.deviceInfo({
      uniqueIdentifier: this.credentials.clientId,
      name: 'Node ATV Remote',
    });
    await this.sendMRPMessage(deviceInfo);

    // Wait for DeviceInfo response from Apple TV
    await this.waitForMRPMessage(MessageType.DeviceInfo, 5000);
    this.log('DeviceInfo exchange complete');

    // 2. CryptoPairing is NOT performed over AirPlay transport.
    // The data channel is already encrypted at the transport layer (HAP session).
    // pyatv's AirPlayMrpConnection.enable_encryption() is a no-op.
    // Sending CryptoPairing confuses some Apple TV models and delays setup.

    // 3. SetConnectionState (fire and forget, pyatv uses send() not send_and_receive())
    const connState = await MRPMessage.setConnectionState(2);
    await this.sendMRPMessage(connState);

    // 4. ClientUpdatesConfig (pyatv waits for a reply; we only send)
    const updatesConfig = await MRPMessage.clientUpdatesConfig({
      artworkUpdates: true,
      nowPlayingUpdates: true,
      volumeUpdates: true,
      keyboardUpdates: true,
    });
    await this.sendMRPMessage(updatesConfig);

    // 5. GetKeyboardSession (pyatv waits for a reply; we only send)
    const getKeyboard = await MRPMessage.sendCommand(MessageType.GetKeyboardSession);
    await this.sendMRPMessage(getKeyboard);

    // ponytail: optional settle after init; 0 by default. Raise ATV_SETTLE_MS (old value 500)
    // if the first command after connect is ignored on some Apple TV model.
    const settleMs = Number(process.env.ATV_SETTLE_MS ?? 0);
    if (settleMs > 0) await delay(settleMs);
  }

  /**
   * Resolve with the next MRP message of `type` from the data channel.
   * @throws (rejects) after `timeoutMs` with no matching message.
   */
  private waitForMRPMessage(type: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingMRPResolvers.findIndex((r) => r.type === type);
        if (idx >= 0) this.pendingMRPResolvers.splice(idx, 1);
        reject(new Error(`Timeout waiting for MRP message type ${type}`));
      }, timeoutMs);

      this.pendingMRPResolvers.push({
        type,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  /** Buffer encrypted control-socket bytes after pair-verify and try to extract an RTSP response. */
  private onEncryptedData(data: Buffer): void {
    this.encryptedBuffer = Buffer.concat([this.encryptedBuffer, data]);
    this.tryParseRTSPResponse();
  }

  /**
   * Once the buffer holds only whole HAP frames, decrypt it and emit `rtsp-response` for the
   * first complete message. Decrypt errors are logged and the data is dropped.
   */
  private tryParseRTSPResponse(): void {
    let decrypted: Buffer;
    try {
      if (this.session && this.encryptedBuffer.length > 0) {
        if (!this.hasCompleteHAPFrame(this.encryptedBuffer)) return;
        decrypted = this.session.decrypt(this.encryptedBuffer);
        this.encryptedBuffer = Buffer.alloc(0);
      } else {
        decrypted = this.encryptedBuffer;
        this.encryptedBuffer = Buffer.alloc(0);
      }
    } catch (err) {
      this.log(`decrypt error: ${err}`);
      return;
    }

    const parsed = parseHTTPMessage(decrypted);
    if (!parsed) {
      this.encryptedBuffer = Buffer.from(decrypted);
      return;
    }

    const remaining = decrypted.subarray(parsed.totalSize);
    if (remaining.length > 0) {
      this.encryptedBuffer = Buffer.from(remaining);
    }

    this.emit('rtsp-response', { headers: parsed.headers, body: parsed.body });
  }

  /** True when `buf` ends on a HAP frame boundary (no trailing partial frame); callers check non-empty. */
  private hasCompleteHAPFrame(buf: Buffer): boolean {
    let offset = 0;
    while (offset < buf.length) {
      if (buf.length - offset < 2) return false;
      const frameLen = buf.readUInt16LE(offset);
      const totalFrameSize = 2 + frameLen + 16;
      if (buf.length - offset < totalFrameSize) return false;
      offset += totalFrameSize;
    }
    return true;
  }

  private eventEncBuffer: Buffer = Buffer.alloc(0);
  private eventDecBuffer = Buffer.alloc(0);

  /** Decrypt event-channel bytes and acknowledge any complete requests from the receiver. */
  private onEventChannelData(data: Buffer): void {
    this.eventEncBuffer = Buffer.concat([this.eventEncBuffer, data]);
    if (!this.eventSession) return;

    try {
      const { plaintext, rest } = this.eventSession.decryptAvailable(this.eventEncBuffer);
      this.eventEncBuffer = rest;
      this.eventDecBuffer = Buffer.concat([this.eventDecBuffer, plaintext]);
    } catch (e) {
      this.log(`event channel decrypt error: ${e}`);
      return;
    }

    // Parse HTTP requests from decrypted data and respond with 200 OK
    this.processEventRequests();
  }

  /** Answer each buffered event-channel request with an encrypted `RTSP/1.0 200 OK`, echoing CSeq and Server. */
  private processEventRequests(): void {
    while (this.eventDecBuffer.length > 0) {
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
      this.eventSocket?.write(encrypted);
    }
  }

  private dataEncBuffer: Buffer = Buffer.alloc(0);

  /**
   * Decrypt data-channel bytes, ack every "sync" DataStream frame with a "rply", and hand
   * each protobuf payload to `handleMRPResponse`.
   */
  private onDataChannelData(data: Buffer): void {
    this.dataEncBuffer = Buffer.concat([this.dataEncBuffer, data]);

    // Decrypt all complete HAP frames in one pass; one concat per chunk, not per 1 KB frame.
    try {
      const { plaintext, rest } = this.dataSession!.decryptAvailable(this.dataEncBuffer);
      this.dataEncBuffer = rest;
      this.dataDecBuffer = Buffer.concat([this.dataDecBuffer, plaintext]);
    } catch (e) {
      this.log(`data channel decrypt error: ${e}`);
      return;
    }

    // Parse complete DataStream frames from the decrypted buffer
    while (this.dataDecBuffer.length >= 32) {
      const frame = parseDataStreamFrame(this.dataDecBuffer, 0);
      if (!frame) break;

      // Send rply for sync frames from the Apple TV
      if (frame.messageType === 'sync') {
        const reply = buildDataStreamReply(frame.seqno);
        const encrypted = this.dataSession!.encrypt(reply);
        this.dataSocket?.write(encrypted);
      }

      if (frame.protobufData) {
        this.handleMRPResponse(frame.protobufData);
      }

      // Advance buffer past this frame
      this.dataDecBuffer = this.dataDecBuffer.subarray(frame.totalSize);
    }
  }

  /**
   * Decode an MRP protobuf, emit it as `mrp-message`, and resolve the oldest waiter for its
   * type. Decode errors are logged, never thrown.
   */
  private async handleMRPResponse(protobufData: Buffer): Promise<void> {
    try {
      const decoded = await MRPMessage.decode(protobufData);
      const msg = decoded as unknown as Record<string, unknown>;
      this.log(`MRP response: type=${msg.type}`);

      // Always emit so that listeners (e.g. AppleTV) can observe all messages
      this.emit('mrp-message', msg);

      // Also resolve any pending resolver that matches this message type
      const idx = this.pendingMRPResolvers.findIndex(
        (r) => r.type === msg.type,
      );
      if (idx >= 0) {
        const resolver = this.pendingMRPResolvers.splice(idx, 1)[0];
        resolver.resolve(msg);
      }
    } catch (e) {
      this.log(`MRP decode error: ${e}`);
    }
  }

  /** POST /feedback every 2 s to keep the AirPlay session alive; failures are only logged. */
  private startFeedbackHeartbeat(): void {
    this.feedbackInterval = setInterval(async () => {
      try {
        await this.sendRTSP('POST', '/feedback');
      } catch (e) {
        this.log(`FEEDBACK error: ${e}`);
      }
    }, 2000);
  }

  /**
   * Send an MRP message and resolve with the next incoming message of `responseType`.
   * The waiter is registered before sending so a fast reply is not missed.
   */
  async sendMRPMessageAndWait(
    protobufData: Buffer,
    responseType: number,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const waitPromise = this.waitForMRPMessage(responseType, timeoutMs);
    await this.sendMRPMessage(protobufData);
    return waitPromise;
  }

  /**
   * Frame an encoded MRP message as DataStream, encrypt it, and write it to the data channel.
   * @throws if the data channel is not connected or the socket write fails.
   */
  async sendMRPMessage(protobufData: Buffer): Promise<void> {
    if (!this.dataSocket || !this.dataSession) throw new Error('Data channel not connected');
    const frame = buildDataStreamFrame(protobufData);
    const encrypted = this.dataSession.encrypt(frame);
    await new Promise<void>((resolve, reject) => {
      this.dataSocket!.write(encrypted, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Stop the heartbeat and destroy all three sockets. Pending waiters are not rejected. */
  close(): void {
    if (this.feedbackInterval) {
      clearInterval(this.feedbackInterval);
      this.feedbackInterval = undefined;
    }
    this.dataSocket?.destroy();
    this.dataSocket = undefined;
    this.eventSocket?.destroy();
    this.eventSocket = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }
}
