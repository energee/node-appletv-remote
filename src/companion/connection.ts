/**
 * Companion protocol connection for Apple TV.
 * Connects via TCP to the companion-link port, performs pair-verify,
 * then exchanges OPACK-encoded messages over encrypted frames.
 */

import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import {
  generateKeyPairSync,
  diffieHellman,
  sign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto';
import { TlvTag, tlvEncode, tlvDecode } from '../util/tlv.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from '../util/crypto.js';
import { FrameType, encodeFrame, parseFrames, type Frame } from './framing.js';
import { CompanionSession } from './companion-session.js';
import {
  opackEncode, opackDecode, type OpackValue, type OpackDict,
} from './opack.js';
import type { HAPCredentials } from '../auth/types.js';

// DER prefixes for raw key import/export
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function x25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function ed25519PrivateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export class CompanionConnection extends EventEmitter {
  private socket: Socket | undefined;
  private session: CompanionSession | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private transferId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: OpackDict) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    private host: string,
    private port: number,
    private credentials: HAPCredentials,
  ) {
    super();
  }

  async connect(): Promise<void> {
    await this.openSocket();
    await this.pairVerify();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();
      this.socket.connect(this.port, this.host, () => resolve());
      this.socket.on('error', (err) => {
        reject(err);
        this.emit('error', err);
      });
      this.socket.on('close', () => this.emit('close'));
      this.socket.on('data', (data: Buffer) => this.onData(data));
    });
  }

  /**
   * Send TLV pairing data wrapped in OPACK { _pd: tlvBytes }.
   */
  private sendPairingData(
    frameType: FrameType,
    tlvData: Buffer,
    extraFields?: Map<OpackValue, OpackValue>,
  ): void {
    const opackPayload = new Map<OpackValue, OpackValue>([
      ['_pd', tlvData],
    ]);
    if (extraFields) {
      for (const [k, v] of extraFields) {
        opackPayload.set(k, v);
      }
    }
    this.writeRaw(encodeFrame(frameType, opackEncode(opackPayload)));
  }

  /**
   * Receive TLV pairing data from an OPACK-wrapped response frame.
   */
  private async receivePairingData(frameType: FrameType): Promise<Buffer> {
    const frame = await this.waitForFrame(frameType);
    const decoded = opackDecode(frame.payload);
    if (!(decoded instanceof Map)) {
      throw new Error('Companion PV: expected OPACK dict response');
    }
    const pd = (decoded as OpackDict).get('_pd');
    if (!Buffer.isBuffer(pd)) {
      throw new Error('Companion PV: response missing _pd data');
    }
    return pd;
  }

  private async pairVerify(): Promise<void> {
    // Generate ephemeral X25519 keypair
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    const ephemeralPubRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );

    // M1: Send our ephemeral public key (PV_Start for first message)
    const m1 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x01]),
      [TlvTag.PublicKey]: ephemeralPubRaw,
    });
    this.sendPairingData(FrameType.PV_Start, m1, new Map([['_auTy', 4]]));

    // M2: Receive server ephemeral key + encrypted proof
    const m2Data = await this.receivePairingData(FrameType.PV_Next);
    const m2 = tlvDecode(m2Data);

    const serverEphemeralPub = m2[TlvTag.PublicKey];
    const m2Encrypted = m2[TlvTag.EncryptedData];
    if (!serverEphemeralPub || !m2Encrypted) {
      const error = m2[TlvTag.Error];
      throw new Error(`Companion PV M2 missing data (error=${error ? error[0] : 'none'})`);
    }

    // Compute shared secret
    const serverEphKeyObj = x25519PublicKeyFromRaw(serverEphemeralPub);
    const sharedSecret = diffieHellman({
      privateKey,
      publicKey: serverEphKeyObj,
    });

    // Derive session key
    const sessionKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Pair-Verify-Encrypt-Salt',
      'Pair-Verify-Encrypt-Info',
      32,
    );

    // Decrypt M2 to verify server
    const m2Nonce = Buffer.alloc(12, 0);
    m2Nonce.write('PV-Msg02', 4);
    const m2Ciphertext = m2Encrypted.subarray(0, m2Encrypted.length - 16);
    const m2Tag = m2Encrypted.subarray(m2Encrypted.length - 16);
    const decrypted = decryptChaCha20(sessionKey, m2Nonce, m2Ciphertext, m2Tag, Buffer.alloc(0));
    const serverInfo = tlvDecode(decrypted);

    const serverIdentifier = serverInfo[TlvTag.Identifier];
    const serverSignature = serverInfo[TlvTag.Signature];
    if (!serverIdentifier || !serverSignature) {
      throw new Error('Companion PV M2 decrypted data missing Identifier or Signature');
    }

    // Verify server signature
    const serverSignedData = Buffer.concat([
      serverEphemeralPub,
      serverIdentifier,
      ephemeralPubRaw,
    ]);
    const serverLTPKObj = ed25519PublicKeyFromRaw(this.credentials.serverLTPK);
    const valid = cryptoVerify(null, serverSignedData, serverLTPKObj, serverSignature);
    if (!valid) {
      throw new Error('Companion server signature verification failed');
    }

    // M3: Sign our proof and encrypt (PV_Next for subsequent messages)
    const clientSignedData = Buffer.concat([
      ephemeralPubRaw,
      Buffer.from(this.credentials.clientId),
      serverEphemeralPub,
    ]);
    const clientPrivKey = ed25519PrivateKeyFromSeed(this.credentials.clientLTSK);
    const clientSignature = sign(null, clientSignedData, clientPrivKey);

    const subTlv = tlvEncode({
      [TlvTag.Identifier]: Buffer.from(this.credentials.clientId),
      [TlvTag.Signature]: clientSignature,
    });

    const m3Nonce = Buffer.alloc(12, 0);
    m3Nonce.write('PV-Msg03', 4);
    const { ciphertext, tag } = encryptChaCha20(sessionKey, m3Nonce, subTlv, Buffer.alloc(0));
    const encryptedData = Buffer.concat([ciphertext, tag]);

    const m3 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.EncryptedData]: encryptedData,
    });
    this.sendPairingData(FrameType.PV_Next, m3);

    // M4: Wait for acknowledgement
    const m4Data = await this.receivePairingData(FrameType.PV_Next);
    const m4 = tlvDecode(m4Data);
    const m4Error = m4[TlvTag.Error];
    if (m4Error && m4Error[0] !== 0) {
      throw new Error(`Companion pair-verify M4 error: ${m4Error[0]}`);
    }

    // Derive encryption keys using Companion-specific HKDF strings
    const outputKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      '',
      'ClientEncrypt-main',
      32,
    );
    const inputKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      '',
      'ServerEncrypt-main',
      32,
    );

    this.session = new CompanionSession(outputKey, inputKey);
  }

  /**
   * Send an OPACK request and wait for a correlated response.
   */
  async sendRequest(
    identifier: string,
    content: OpackDict,
    timeoutMs = 5000,
  ): Promise<OpackDict> {
    if (!this.session || !this.socket) {
      throw new Error('Companion not connected');
    }

    const tid = this.transferId++;
    content.set('_i', identifier);
    content.set('_x', tid);

    const payload = opackEncode(content);
    const encrypted = this.session.encrypt(FrameType.E_OPACK, payload);
    this.writeRaw(encrypted);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(tid);
        reject(new Error(`Companion request timeout: ${identifier}`));
      }, timeoutMs);

      this.pendingRequests.set(tid, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Send an OPACK message without waiting for a response.
   */
  sendMessage(identifier: string, content: OpackDict): void {
    if (!this.session || !this.socket) {
      throw new Error('Companion not connected');
    }

    content.set('_i', identifier);
    const payload = opackEncode(content);
    const encrypted = this.session.encrypt(FrameType.E_OPACK, payload);
    this.writeRaw(encrypted);
  }

  close(): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
    this.socket?.destroy();
    this.socket = undefined;
    this.session = undefined;
  }

  private writeRaw(data: Buffer): void {
    this.socket?.write(data);
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);

    if (!this.session) {
      // Before encryption is established, buffer raw frames for waitForFrame
      this.processRawFrames();
    } else {
      this.processEncryptedFrames();
    }
  }

  // --- Pre-encryption frame handling (pair-verify) ---

  private pendingFrameResolvers: Array<{
    type: FrameType;
    resolve: (frame: Frame) => void;
  }> = [];

  private waitForFrame(type: FrameType, timeoutMs = 5000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const entry = {
        type,
        resolve: (frame: Frame): void => {
          clearTimeout(timer);
          resolve(frame);
        },
      };

      const timer = setTimeout(() => {
        const idx = this.pendingFrameResolvers.indexOf(entry);
        if (idx >= 0) this.pendingFrameResolvers.splice(idx, 1);
        reject(new Error(`Timeout waiting for frame type ${type}`));
      }, timeoutMs);

      this.pendingFrameResolvers.push(entry);

      // Try to process any already-buffered data
      this.processRawFrames();
    });
  }

  private processRawFrames(): void {
    const { frames, remainder } = parseFrames(this.buffer);
    this.buffer = remainder;

    for (const frame of frames) {
      const idx = this.pendingFrameResolvers.findIndex((r) => r.type === frame.type);
      if (idx >= 0) {
        const resolver = this.pendingFrameResolvers.splice(idx, 1)[0];
        resolver.resolve(frame);
      }
    }
  }

  // --- Post-encryption frame handling ---

  private processEncryptedFrames(): void {
    // Encrypted frames: 4-byte header + ciphertext + 16-byte tag
    // The header contains the plaintext length, so total = 4 + plaintextLen + 16
    while (this.buffer.length >= 4) {
      const plaintextLen =
        (this.buffer[1] << 16) | (this.buffer[2] << 8) | this.buffer[3];
      const totalLen = 4 + plaintextLen + 16;

      if (this.buffer.length < totalLen) break;

      const header = this.buffer.subarray(0, 4);
      const encryptedPayload = this.buffer.subarray(4, totalLen);
      this.buffer = Buffer.from(this.buffer.subarray(totalLen));

      try {
        const plaintext = this.session!.decrypt(header, encryptedPayload);
        const decoded = opackDecode(plaintext);
        this.handleMessage(decoded);
      } catch (e) {
        this.emit('error', new Error(`Companion decrypt error: ${e}`));
      }
    }
  }

  private handleMessage(value: OpackValue): void {
    if (!(value instanceof Map)) return;

    const dict = value as OpackDict;
    const transferId = dict.get('_x');
    const identifier = dict.get('_i');

    // Check if this is a response to a pending request
    if (typeof transferId === 'number' && this.pendingRequests.has(transferId)) {
      const pending = this.pendingRequests.get(transferId)!;
      this.pendingRequests.delete(transferId);
      pending.resolve(dict);
      return;
    }

    // Otherwise it's an unsolicited event
    this.emit('event', { identifier, data: dict });
  }
}
