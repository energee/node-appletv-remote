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
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { HAPSession } from './util/hap-session.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from './util/crypto.js';
import { TlvTag, tlvEncode, tlvDecode } from './util/tlv.js';
import { MRPMessage, MessageType } from './mrp/messages.js';
import { buildDataStreamFrame, buildDataStreamReply, parseDataStreamFrame } from './util/data-stream.js';
import type { HAPCredentials } from './auth/types.js';

const DATA_CHANNEL_TYPE_UUID = '1910A70F-DBC0-4242-AF95-115DB30604E1';
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface ParsedHTTP {
  headers: Record<string, string>;
  body: Buffer;
  totalSize: number;
}

/** Parse an HTTP message (request or response) from a buffer. Returns null if incomplete. */
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

/** Connect a socket to host:port and return it once connected. */
function connectSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    sock.connect(port, host, () => resolve(sock));
    sock.once('error', reject);
  });
}

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
    type?: number;
    resolve: (msg: Record<string, unknown>) => void;
  }> = [];

  constructor(
    private host: string,
    private port: number,
    private credentials: HAPCredentials,
  ) {
    super();
  }

  async connect(): Promise<void> {
    // Step 1: Open TCP connection
    this.log('opening TCP connection...');
    this.socket = await connectSocket(this.host, this.port);
    this.localAddress = this.socket.localAddress;
    this.log(`TCP connected (local ${this.localAddress})`);

    // Initially handle raw (unencrypted) data for pair-verify
    this.socket.on('data', (data) => this.onRawData(Buffer.from(data)));
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
    this.socket.on('data', (data) => this.onEncryptedData(Buffer.from(data)));

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

  private log(msg: string): void {
    console.error(`[AirPlay] ${msg}`);
  }

  // --- Pair-verify directly on the RTSP socket ---

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

  /** Send a plain HTTP POST on the raw socket and read the response */
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

  /** Handle raw (unencrypted) data during pair-verify phase */
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

  private get rtspUri(): string {
    return `rtsp://${this.localAddress}/${this.sessionId}`;
  }

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
      this.eventSocket.on('data', (data) => this.onEventChannelData(Buffer.from(data)));
      this.eventSocket.on('error', (err) => this.log(`event channel error: ${err.message}`));
      this.eventSocket.on('close', () => this.log('event channel closed'));
    }
  }

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

    this.dataSocket.on('data', (data) => this.onDataChannelData(Buffer.from(data)));
    this.dataSocket.on('error', (err) => this.log(`data channel error: ${err.message}`));
    this.dataSocket.on('close', () => this.log('data channel closed by remote'));
    this.dataSocket.on('end', () => this.log('data channel ended by remote'));

    // Initialize MRP protocol on data channel
    await this.initMRPProtocol();
  }

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

    // 4. ClientUpdatesConfig (pyatv uses send_and_receive)
    const updatesConfig = await MRPMessage.clientUpdatesConfig({
      artworkUpdates: true,
      nowPlayingUpdates: true,
      volumeUpdates: true,
      keyboardUpdates: true,
    });
    await this.sendMRPMessage(updatesConfig);

    // 5. GetKeyboardSession (pyatv uses send_and_receive)
    const getKeyboard = await MRPMessage.sendCommand(MessageType.GetKeyboardSession);
    await this.sendMRPMessage(getKeyboard);

    // Wait a moment for the Apple TV to process init messages and send updates
    await new Promise((r) => setTimeout(r, 500));
  }

  /** Wait for an MRP message of a specific type from the data channel */
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

  /** Perform MRP-level pair-verify using CryptoPairingMessage */
  private async mrpPairVerify(): Promise<void> {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const ephemeralPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );

    // M1: Send our ephemeral public key
    // Manually construct TLV with SeqNo first (pyatv order) since JS sorts
    // numeric object keys ascending, which would put PublicKey(3) before SeqNo(6)
    const m1Tlv = Buffer.concat([
      Buffer.from([TlvTag.SeqNo, 0x01, 0x01]),
      Buffer.from([TlvTag.PublicKey, ephemeralPublicKeyRaw.length]),
      ephemeralPublicKeyRaw,
    ]);
    const m1Msg = await MRPMessage.cryptoPairing(m1Tlv);
    const m2Promise = this.waitForMRPMessage(MessageType.CryptoPairing, 10000);
    await this.sendMRPMessage(m1Msg);

    // Wait for M2 response
    const m2Response = await m2Promise;
    const m2PairingData = (m2Response as any)['.cryptoPairingMessage']?.pairingData as Buffer;
    if (!m2PairingData) throw new Error('M2 missing pairingData');

    const m2Tlv = tlvDecode(m2PairingData);
    const serverEphemeralPub = m2Tlv[TlvTag.PublicKey];
    const m2Encrypted = m2Tlv[TlvTag.EncryptedData];
    if (!serverEphemeralPub || !m2Encrypted) {
      throw new Error('MRP M2 missing PublicKey or EncryptedData');
    }

    // Compute shared secret
    const serverEphemeralKeyObj = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, serverEphemeralPub]),
      format: 'der',
      type: 'spki',
    });
    const sharedSecret = diffieHellman({ privateKey, publicKey: serverEphemeralKeyObj });

    // Derive session key for TLV encryption
    const sessionKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Pair-Verify-Encrypt-Salt',
      'Pair-Verify-Encrypt-Info',
      32,
    );

    // Decrypt M2 sub-TLV
    const m2Nonce = Buffer.alloc(12, 0);
    m2Nonce.write('PV-Msg02', 4);
    const m2Ciphertext = m2Encrypted.subarray(0, m2Encrypted.length - 16);
    const m2Tag = m2Encrypted.subarray(m2Encrypted.length - 16);
    const decrypted = decryptChaCha20(sessionKey, m2Nonce, m2Ciphertext, m2Tag, Buffer.alloc(0));
    const serverInfo = tlvDecode(decrypted);

    const serverIdentifier = serverInfo[TlvTag.Identifier];
    const serverSignature = serverInfo[TlvTag.Signature];
    if (!serverIdentifier || !serverSignature) {
      throw new Error('MRP M2 decrypted data missing Identifier or Signature');
    }

    // Verify server signature
    const serverSignedData = Buffer.concat([serverEphemeralPub, serverIdentifier, ephemeralPublicKeyRaw]);
    const serverLTPKObj = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, this.credentials.serverLTPK]),
      format: 'der',
      type: 'spki',
    });
    const valid = cryptoVerify(null, serverSignedData, serverLTPKObj, serverSignature);
    if (!valid) throw new Error('MRP server signature verification failed');

    // Sign our proof for M3
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

    // Encrypt M3 sub-TLV
    const subTlv = tlvEncode({
      [TlvTag.Identifier]: Buffer.from(this.credentials.clientId),
      [TlvTag.Signature]: clientSignature,
    });
    const m3Nonce = Buffer.alloc(12, 0);
    m3Nonce.write('PV-Msg03', 4);
    const { ciphertext, tag } = encryptChaCha20(sessionKey, m3Nonce, subTlv, Buffer.alloc(0));

    const m3Tlv = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.EncryptedData]: Buffer.concat([ciphertext, tag]),
    });
    const m3Msg = await MRPMessage.cryptoPairing(m3Tlv);
    const m4Promise = this.waitForMRPMessage(MessageType.CryptoPairing);
    await this.sendMRPMessage(m3Msg);

    // Wait for M4 acknowledgment
    await m4Promise;

    // Over AirPlay, MRP encryption keys are derived but NOT applied.
    // The data channel is already encrypted at the transport layer.
    // This matches pyatv's AirPlayMrpConnection.enable_encryption() which is a no-op.
    this.log('MRP pair-verify complete (encryption not applied over AirPlay)');
  }

  /** Handle encrypted data after pair-verify is complete */
  private onEncryptedData(data: Buffer): void {
    this.encryptedBuffer = Buffer.concat([this.encryptedBuffer, data]);
    this.tryParseRTSPResponse();
  }

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

  private eventEncBuffer = Buffer.alloc(0);
  private eventDecBuffer = Buffer.alloc(0);

  private onEventChannelData(data: Buffer): void {
    this.eventEncBuffer = Buffer.concat([this.eventEncBuffer, data]);
    if (!this.eventSession) return;

    // Decrypt HAP frames from the event channel
    while (this.eventEncBuffer.length >= 2) {
      const frameLen = this.eventEncBuffer.readUInt16LE(0);
      const totalFrameSize = 2 + frameLen + 16; // length + ciphertext + auth tag
      if (this.eventEncBuffer.length < totalFrameSize) break;

      const frame = this.eventEncBuffer.subarray(0, totalFrameSize);
      this.eventEncBuffer = this.eventEncBuffer.subarray(totalFrameSize);

      try {
        const decrypted = this.eventSession.decrypt(frame);
        this.eventDecBuffer = Buffer.concat([this.eventDecBuffer, decrypted]);
      } catch (e) {
        this.log(`event channel decrypt error: ${e}`);
        return;
      }
    }

    // Parse HTTP requests from decrypted data and respond with 200 OK
    this.processEventRequests();
  }

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

  private dataEncBuffer = Buffer.alloc(0);

  private onDataChannelData(data: Buffer): void {
    this.dataEncBuffer = Buffer.concat([this.dataEncBuffer, data]);

    // Wait for complete HAP frames before decrypting
    while (this.dataEncBuffer.length >= 2) {
      const frameLen = this.dataEncBuffer.readUInt16LE(0);
      const totalFrameSize = 2 + frameLen + 16; // length + ciphertext + auth tag
      if (this.dataEncBuffer.length < totalFrameSize) break;

      const frame = this.dataEncBuffer.subarray(0, totalFrameSize);
      this.dataEncBuffer = this.dataEncBuffer.subarray(totalFrameSize);

      try {
        const decrypted = this.dataSession!.decrypt(frame);
        this.dataDecBuffer = Buffer.concat([this.dataDecBuffer, decrypted]);
      } catch (e) {
        this.log(`data channel decrypt error: ${e}`);
        return;
      }
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

  private async handleMRPResponse(protobufData: Buffer): Promise<void> {
    try {
      const decoded = await MRPMessage.decode(protobufData);
      const msg = decoded as unknown as Record<string, unknown>;
      this.log(`MRP response: type=${msg.type}`);

      // Always emit so that listeners (e.g. AppleTV) can observe all messages
      this.emit('mrp-message', msg);

      // Also resolve any pending resolver that matches this message type
      const idx = this.pendingMRPResolvers.findIndex(
        (r) => r.type === undefined || r.type === msg.type,
      );
      if (idx >= 0) {
        const resolver = this.pendingMRPResolvers.splice(idx, 1)[0];
        resolver.resolve(msg);
      }
    } catch (e) {
      this.log(`MRP decode error: ${e}`);
    }
  }

  private startFeedbackHeartbeat(): void {
    this.feedbackInterval = setInterval(async () => {
      try {
        await this.sendRTSP('POST', '/feedback');
      } catch (e) {
        this.log(`FEEDBACK error: ${e}`);
      }
    }, 2000);
  }

  async sendMRPMessageAndWait(
    protobufData: Buffer,
    responseType: number,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const waitPromise = this.waitForMRPMessage(responseType, timeoutMs);
    await this.sendMRPMessage(protobufData);
    return waitPromise;
  }

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
