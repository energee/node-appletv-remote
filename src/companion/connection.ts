/**
 * Companion protocol connection for Apple TV.
 * Connects via TCP to the companion-link port, performs pair-verify with stored
 * pair-setup credentials, then exchanges OPACK-encoded messages over encrypted frames.
 */

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { connectSocket } from '../connection.js';
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
import { hkdfSha512, encryptChaCha20, decryptChaCha20, X25519_SPKI_PREFIX, ED25519_SPKI_PREFIX, ED25519_PKCS8_PREFIX } from '../util/crypto.js';
import { FrameType, encodeFrame, parseFrames, type Frame } from './framing.js';
import { CompanionSession } from './companion-session.js';
import {
  opackEncode, opackDecode, type OpackValue, type OpackDict,
} from './opack.js';
import type { HAPCredentials } from '../auth/types.js';

// DER prefixes that turn raw 32-byte keys into SPKI/PKCS#8 for node:crypto import.

/** Import a raw 32-byte X25519 public key. */
function x25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Import a raw 32-byte Ed25519 public key. */
function ed25519PublicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Import an Ed25519 private key from its 32-byte seed. */
function ed25519PrivateKeyFromSeed(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** Largest request ID an Apple TV echoes unchanged (one-byte OPACK integers are signed). */
const MAX_TRANSFER_ID = 127;
/** How long a timed-out request ID stays reserved in case its reply arrives late. */
const LATE_REPLY_WINDOW_MS = 30_000;

/**
 * Wrap content in the Companion envelope `{ _t, _c }`. Content that already has an envelope
 * key (`_t`, `_c` or `_x`) is a prebuilt envelope and is copied as-is, so callers that built
 * the envelope themselves keep working. Companion content keys never use these names.
 */
function envelope(content: OpackDict, type: number): OpackDict {
  if (content.has('_t') || content.has('_c') || content.has('_x')) return new Map(content);
  return new Map<OpackValue, OpackValue>([['_t', type], ['_c', content]]);
}

/**
 * An authenticated, encrypted Companion link to one Apple TV.
 * Emits `event` ({ identifier, data }) for unsolicited messages, plus `error` (when observed) and `close`.
 */
export class CompanionConnection extends EventEmitter {
  private socket: Socket | undefined;
  private closed = false;
  private connecting = false;
  private setupAbort?: AbortController;
  private session: CompanionSession | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  // A real TV may treat transaction zero as unacknowledged traffic.
  private transferId = 1;
  // Request IDs that timed out; reserved until the late reply arrives or the window passes.
  private timedOutIds = new Map<number, NodeJS.Timeout>();
  /** Requests awaiting a `_t: 3` reply, keyed by their `_x` ID. */
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

  /**
   * Open the TCP socket and run pair-verify; resolves once traffic is encrypted.
   * Concurrent connect calls reject; await canceled setup before reusing this instance.
   * @throws on cancellation, socket errors, a bad server signature, or a frame timeout
   */
  async connect(): Promise<void> {
    if (this.connecting || this.socket) throw new Error('Companion already connected');
    this.connecting = true;
    this.closed = false;
    this.setupAbort = new AbortController();
    try {
      await this.openSocket();
      await this.pairVerify();
      if (this.closed) throw new Error('Companion closed during setup');
    } catch (err) {
      this.close();
      throw err;
    } finally {
      this.connecting = false;
    }
  }

  /** Connect the socket (Nagle off, 5 s timeout) and wire its events; later errors are re-emitted as `error`. */
  private async openSocket(): Promise<void> {
    const socket = await connectSocket(this.host, this.port, 5000, this.setupAbort?.signal);
    if (this.closed) { socket.destroy(); throw new Error('Companion closed during setup'); }
    this.socket = socket;
    socket.on('error', err => { if (this.socket === socket) this.fail(err); });
    socket.on('close', () => { if (this.socket === socket) this.close(); });
    socket.on('end', () => { if (this.socket === socket) this.close(); });
    this.socket.on('data', (data: Buffer) => this.onData(data));
  }

  /** Send TLV pairing data wrapped in OPACK `{ _pd: tlvBytes, ...extraFields }`, unencrypted. */
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
   * Wait for a frame of `frameType` and return its `_pd` TLV bytes.
   * @throws if the payload is not an OPACK dict or lacks `_pd`, or on frame timeout
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

  /**
   * Run the four-message pair-verify exchange (M1-M4): ECDH on ephemeral X25519 keys,
   * mutual Ed25519 signatures with the long-term keys, then derive the session keys.
   */
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
    // Register before writing: a write failure or immediate reply must settle this waiter.
    const m2Response = this.receivePairingData(FrameType.PV_Next);
    try { this.sendPairingData(FrameType.PV_Start, m1, new Map([['_auTy', 4]])); }
    catch (err) { this.fail(err); }
    const m2Data = await m2Response;
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
    if (this.closed) throw new Error('Companion closed during setup');
    const m4Response = this.receivePairingData(FrameType.PV_Next);
    try { this.sendPairingData(FrameType.PV_Next, m3); }
    catch (err) { this.fail(err); }
    const m4Data = await m4Response;
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

    if (this.closed) throw new Error('Companion closed during setup');
    this.session = new CompanionSession(outputKey, inputKey);
  }

  /**
   * Send an OPACK request and wait for a correlated response.
   * Bare content is wrapped as `{ _i, _t: 2, _c: content, _x }`; content that already has
   * `_t`, `_c` or `_x` is treated as a prebuilt envelope; `_i` is set and `_x` is overwritten.
   * @returns the whole reply dict (envelope included), not just its `_c`
   * @throws if not connected or no request ID is free; rejects on timeout or close()
   */
  async sendRequest(
    identifier: string,
    content: OpackDict,
    timeoutMs = 5000,
  ): Promise<OpackDict> {
    if (!this.session || !this.socket) {
      throw new Error('Companion not connected');
    }

    const tid = this.nextTransferId();
    if (tid === undefined) throw new Error('Companion has no free request ID');
    const message = envelope(content, 2);
    message.set('_i', identifier);
    message.set('_x', tid);

    const payload = opackEncode(message);
    const encrypted = this.session.encrypt(FrameType.E_OPACK, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(tid);
        // Keep the ID out of rotation so a late reply cannot resolve a newer request.
        const release = setTimeout(() => this.timedOutIds.delete(tid), LATE_REPLY_WINDOW_MS);
        release.unref();
        this.timedOutIds.set(tid, release);
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
      try { this.writeRaw(encrypted); }
      catch (err) { this.fail(err); }
    });
  }

  /**
   * Apple TVs read one-byte OPACK integers as signed, so an ID from 128 to 255 comes back
   * changed (255 returns as -1) and its reply never matches. Keep IDs in 1..127, skipping
   * any still awaiting a reply or reserved after a timeout.
   */
  private nextTransferId(): number | undefined {
    for (let attempt = 0; attempt < MAX_TRANSFER_ID; attempt++) {
      const id = this.transferId;
      this.transferId = id >= MAX_TRANSFER_ID ? 1 : id + 1;
      if (!this.isIdInUse(id)) return id;
    }
    return undefined;
  }

  /** Whether `id` is awaiting a reply or reserved after a timeout. */
  private isIdInUse(id: OpackValue): boolean {
    return typeof id === 'number' && (this.pendingRequests.has(id) || this.timedOutIds.has(id));
  }

  /**
   * Send an OPACK message without waiting for a response. Bare content is wrapped as an
   * event, `{ _i, _t: 1, _c: content, _x }`, unless it already has `_t`, `_c` or `_x`.
   * It shares the request ID counter; when every ID is in use it reuses one rather than
   * throwing, since no reply is awaited.
   * @throws if not connected, or if a prebuilt `_x` belongs to an outstanding request
   */
  sendMessage(identifier: string, content: OpackDict): void {
    if (!this.session || !this.socket) {
      throw new Error('Companion not connected');
    }

    const message = envelope(content, 1);
    message.set('_i', identifier);
    if (!message.has('_x')) {
      message.set('_x', this.nextTransferId() ?? this.transferId);
    } else if (this.isIdInUse(message.get('_x')!)) {
      throw new Error(`Companion _x ${message.get('_x')} is in use by a pending request`);
    }
    const payload = opackEncode(message);
    const encrypted = this.session.encrypt(FrameType.E_OPACK, payload);
    this.writeRaw(encrypted);
  }

  /** Cancel TCP/setup, reject pending work, and destroy the socket.
   * Idempotent; emits close for partial setup once a socket was installed, even before connect resolves.
   */
  close(reason = new Error('Connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.setupAbort?.abort();
    const hadSocket = !!this.socket;
    for (const entry of this.pendingFrameResolvers.splice(0)) entry.reject(reason);
    for (const [, pending] of this.pendingRequests) {
      pending.reject(reason);
    }
    this.pendingRequests.clear();
    for (const timer of this.timedOutIds.values()) clearTimeout(timer);
    this.timedOutIds.clear();
    this.socket?.destroy();
    this.socket = undefined;
    this.session = undefined;
    this.buffer = Buffer.alloc(0);
    if (hadSocket) this.emit('close');
  }

  /** Terminate a failed transport and notify observers after pending work has settled. */
  private fail(cause: unknown): void {
    if (this.closed) return;
    const err = cause instanceof Error ? cause : new Error(String(cause));
    this.close(err);
    if (this.listenerCount('error')) this.emit('error', err);
  }

  /** Write bytes as-is; write errors terminate the connection and reject pending work; synchronous errors also throw. */
  private writeRaw(data: Buffer): void {
    if (!this.socket) throw new Error('Companion not connected');
    const socket = this.socket;
    try { socket.write(data, err => { if (err && this.socket === socket) this.fail(err); }); }
    catch (err) { this.fail(err); throw err; }
  }

  /** Buffer socket data and route it to the plaintext or encrypted frame handler. */
  private onData(data: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, data]);

    if (!this.session) {
      // Before encryption is established, buffer raw frames for waitForFrame
      this.processRawFrames();
    } else {
      this.processEncryptedFrames();
    }
  }

  // --- Pre-encryption frame handling (pair-verify) ---

  /** Pair-verify waiters, each matched to the first arriving frame of its type. */
  private pendingFrameResolvers: Array<{
    type: FrameType;
    resolve: (frame: Frame) => void;
    reject: (err: Error) => void;
  }> = [];

  /**
   * Resolve with the next frame of `type`. Frames that arrive with no matching waiter
   * are dropped, so the waiter must be registered before the reply can arrive.
   */
  private waitForFrame(type: FrameType, timeoutMs = 5000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const entry = {
        type,
        reject: (err: Error): void => { clearTimeout(timer); reject(err); },
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

  /** Parse buffered plaintext frames and hand each to a waiter of the same type, if any. */
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

  /**
   * Decrypt and dispatch every complete frame in the buffer. A decrypt or decode failure
   * terminates the connection and rejects pending work. The frame type byte is not checked.
   */
  private processEncryptedFrames(): void {
    // Encrypted frames: 4-byte header + ciphertext + 16-byte tag.
    // The header length already includes the authentication tag.
    while (this.buffer.length >= 4) {
      const payloadLen = this.buffer.readUIntBE(1, 3);
      const totalLen = 4 + payloadLen;

      if (this.buffer.length < totalLen) break;

      const header = this.buffer.subarray(0, 4);
      const encryptedPayload = this.buffer.subarray(4, totalLen);
      // A view, not a copy: copying the tail per frame is O(n²) for a chunk of many frames.
      this.buffer = this.buffer.subarray(totalLen);

      // Companion leaves empty frames unencrypted; decrypting one would consume a nonce.
      if (payloadLen === 0) continue;

      try {
        const plaintext = this.session!.decrypt(header, encryptedPayload);
        const decoded = opackDecode(plaintext);
        this.handleMessage(decoded);
      } catch (e) {
        this.fail(new Error(`Companion decrypt error: ${e}`));
        return;
      }
    }
  }

  /**
   * Route a decrypted message: a `_t: 3` reply resolves its pending request or frees a
   * timed-out ID; anything else (non-dicts are ignored) is emitted as `event`.
   */
  private handleMessage(value: OpackValue): void {
    if (!(value instanceof Map)) return;

    const dict = value as OpackDict;
    const transferId = dict.get('_x');
    const identifier = dict.get('_i');

    // Check if this is a response to a pending request
    if (dict.get('_t') === 3 && typeof transferId === 'number' && this.pendingRequests.has(transferId)) {
      const pending = this.pendingRequests.get(transferId)!;
      this.pendingRequests.delete(transferId);
      pending.resolve(dict);
      return;
    }

    // A late reply to a timed-out request frees its ID; it resolves nothing.
    if (dict.get('_t') === 3 && typeof transferId === 'number' && this.timedOutIds.has(transferId)) {
      clearTimeout(this.timedOutIds.get(transferId));
      this.timedOutIds.delete(transferId);
      return;
    }

    // Otherwise it's an unsolicited event
    this.emit('event', { identifier, data: dict });
  }
}
