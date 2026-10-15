/** Standalone legacy MRP: varint protobuf frames and MediaRemote ChaCha20 keys (pyatv 0.18.0). */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { connectSocket } from '../connection.js';
import { PairSetup } from '../auth/pair-setup.js';
import { PairVerify } from '../auth/pair-verify.js';
import type { HAPCredentials } from '../auth/types.js';
import { decryptChaCha20, encryptChaCha20, generateNonce, hkdfSha512 } from '../util/crypto.js';
import { TlvTag, tlvDecode } from '../util/tlv.js';
import { encodeVarint, decodeVarint } from '../util/data-stream.js';
import { MRPConnection } from './connection.js';
import { MRPMessage, MessageType } from './messages.js';

/** A direct MRP TCP connection for older tvOS, separate from AirPlay credentials. */
export class LegacyMRPConnection extends MRPConnection {
  private socket?: Socket;
  private connecting = false;
  private setupAbort?: AbortController;
  private heartbeatInFlight = false;
  private pendingWrites = new Set<(error: Error) => void>();
  private buffer: Buffer = Buffer.alloc(0);
  private outputKey?: Buffer;
  private inputKey?: Buffer;
  private outCounter = 0n;
  private inCounter = 0n;
  private heartbeat?: ReturnType<typeof setInterval>;
  // Serialize async protobuf handling so verification can enable encryption before the next frame.
  private receiving = Promise.resolve();
  private encryptionReady?: Promise<void>;
  private releaseEncryption?: () => void;

  constructor(private host: string, private port: number, credentials: HAPCredentials, settleMs = 0) {
    super(credentials, settleMs);
  }

  /** Open, verify and subscribe; reject overlapping setup. Close cancels setup; await it before reuse. */
  async connect(): Promise<void> {
    if (this.connecting || this.socket) throw new Error('MRP already connected');
    this.connecting = true;
    try {
      await this.open();
      await this.initMRPProtocol();
      if (this.closed) throw new Error('MRP connection closed during setup');
      this.heartbeat = setInterval(() => {
        if (this.closed || this.heartbeatInFlight) return;
        this.heartbeatInFlight = true;
        void MRPMessage.sendCommand(MessageType.GenericMessage).then((data) => this.sendMRPMessageAndWait(data, MessageType.GenericMessage))
          .catch((error) => this.fail(error)).finally(() => { this.heartbeatInFlight = false; });
      }, 30000);
    } catch (error) {
      this.close();
      throw error;
    } finally { this.connecting = false; }
  }

  /** Reject active exchanges before optionally delivering an error event. */
  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    if (this.listenerCount('error')) this.emit('error', error);
  }

  private async open(): Promise<void> {
    this.closed = false;
    this.setupAbort = new AbortController();
    const generation = this.mrpGeneration;
    const socket = await connectSocket(this.host, this.port, 5000, this.setupAbort.signal);
    if (this.closed || generation !== this.mrpGeneration) { socket.destroy(); throw new Error('MRP connection closed during setup'); }
    this.socket = socket;
    const current = () => this.socket === socket && !this.closed;
    socket.on('error', error => { if (current()) this.fail(error); });
    socket.on('close', () => { if (current()) this.close(); });
    socket.on('end', () => { if (current()) this.close(); });
    socket.on('data', (chunk: Buffer) => {
      if (!current()) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.receiving = this.receiving.then(() => current() ? this.receive() : undefined).catch(error => {
        if (current()) this.fail(error);
      });
    });
  }

  /** PairSetup's HTTP-shaped carrier maps every TLV exchange to CryptoPairing on this socket. */
  pairingTransport(): { post: (path: string, body: Buffer) => Promise<Buffer>; destroy: () => void } {
    return {
      post: async (path, body) => {
        if (path === '/pair-pin-start') return Buffer.alloc(0);
        const sequence = tlvDecode(body)[TlvTag.SeqNo]?.[0];
        const request = await MRPMessage.cryptoPairing(body, path === '/pair-setup' && sequence === 1);
        const responseWait = this.waitForMRPMessage(MessageType.CryptoPairing);
        void this.sendMRPMessage(request).catch(error => this.rejectMRPRequests(error));
        const response = await responseWait;
        const inner = response['.cryptoPairingMessage'] as { status?: number; pairingData?: Buffer } | undefined;
        if (!inner?.pairingData || inner.status) throw new Error(`MRP CryptoPairing rejected (status=${inner?.status})`);
        const data = Buffer.from(inner.pairingData);
        const tlv = tlvDecode(data);
        if (tlv[TlvTag.Error]?.[0]) throw new Error(`MRP pairing error: ${tlv[TlvTag.Error][0]}`);
        if (tlv[TlvTag.SeqNo]?.[0] !== (sequence ?? 0) + 1) throw new Error('Unexpected MRP pairing sequence');
        return data;
      },
      destroy: () => this.close(),
    };
  }

  /** Start DeviceInfo and M1; keep one pairing identity and cache M2 for finish(pin). */
  async startPairing(): Promise<PairSetup> {
    if (this.connecting || this.socket) throw new Error('MRP already connected');
    this.connecting = true;
    const carrier = this.pairingTransport();
    let m2: Buffer | undefined;
    const cachedCarrier = {
      post: (path: string, body: Buffer) => {
        if (path === '/pair-setup' && m2) {
          const response = m2;
          m2 = undefined;
          return Promise.resolve(response);
        }
        return carrier.post(path, body);
      },
      destroy: carrier.destroy,
    };
    const setup = new PairSetup(this.host, this.port, cachedCarrier);
    try {
      await this.open();
      const deviceInfo = await MRPMessage.deviceInfo({ uniqueIdentifier: randomUUID(), name: 'Node ATV Remote' });
      const response = this.waitForMRPMessage(MessageType.DeviceInfo);
      void this.sendMRPMessage(deviceInfo).catch(error => this.rejectMRPRequests(error));
      await response;
      m2 = await carrier.post('/pair-setup', setup.buildM1());
      return setup;
    } catch (error) {
      this.close();
      throw error;
    } finally { this.connecting = false; }
  }

  protected async authenticateMRP(): Promise<void> {
    const generation = this.mrpGeneration;
    this.encryptionReady = new Promise((resolve) => { this.releaseEncryption = resolve; });
    const carrier = this.pairingTransport();
    const verify = new PairVerify(this.host, this.port, this.credentials, { post: carrier.post, destroy() {} });
    try {
      const { sharedSecret } = await verify.verify();
      const outputKey = await hkdfSha512(sharedSecret, 'MediaRemote-Salt', 'MediaRemote-Write-Encryption-Key', 32);
      const inputKey = await hkdfSha512(sharedSecret, 'MediaRemote-Salt', 'MediaRemote-Read-Encryption-Key', 32);
      if (this.closed || generation !== this.mrpGeneration) throw new Error('MRP connection closed during verification');
      this.outputKey = outputKey;
      this.inputKey = inputKey;
    } finally {
      this.releaseEncryption?.();
    }
  }

  /** Encrypt the protobuf (not its varint length), with one counter nonce per message. */
  async sendMRPMessage(data: Buffer): Promise<void> {
    if (!this.socket || this.closed) throw new Error('MRP socket not connected');
    if (this.outputKey) {
      const sealed = encryptChaCha20(this.outputKey, generateNonce(this.outCounter++), data, Buffer.alloc(0));
      data = Buffer.concat([sealed.ciphertext, sealed.tag]);
    }
    const frame = Buffer.concat([encodeVarint(data.length), data]);
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.pendingWrites.delete(fail); reject(error); };
      this.pendingWrites.add(fail);
      try { socket.write(frame, error => {
        this.pendingWrites.delete(fail);
        if (error) { if (this.socket === socket && !this.closed) this.fail(error); reject(error); } else resolve();
      }); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private async receive(): Promise<void> {
    const generation = this.mrpGeneration;
    while (this.buffer.length && !this.closed && generation === this.mrpGeneration) {
      const { value: size, bytesRead: prefix } = decodeVarint(this.buffer);
      if (prefix > 4 || size > 16 * 1024 * 1024) throw new Error('MRP frame too large');
      if (this.buffer[prefix - 1] & 0x80 || this.buffer.length < prefix + size) return;
      let data = this.buffer.subarray(prefix, prefix + size);
      this.buffer = this.buffer.subarray(prefix + size);
      if (this.inputKey) {
        if (data.length < 16) throw new Error('Truncated encrypted MRP frame');
        data = decryptChaCha20(this.inputKey, generateNonce(this.inCounter++), data.subarray(0, -16), data.subarray(-16), Buffer.alloc(0));
      }
      try { await this.handleMRPResponse(data); }
      catch (error) { queueMicrotask(() => { throw error; }); }
      if (this.closed || generation !== this.mrpGeneration) return;
      if (this.encryptionReady && !this.inputKey) {
        const message = await MRPMessage.decode(data);
        const pairing = message['.cryptoPairingMessage'] as { pairingData?: Buffer } | undefined;
        if (pairing?.pairingData && tlvDecode(Buffer.from(pairing.pairingData))[TlvTag.SeqNo]?.[0] === 4) {
          // M4 and the first encrypted update can arrive in the same TCP read.
          await this.encryptionReady;
        }
      }
    }
  }

  /** Cancel setup/writes/waiters, invalidate decodes, clear encryption and stop the heartbeat. */
  close(reason = new Error('MRP connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.mrpGeneration++;
    this.setupAbort?.abort();
    this.rejectMRPRequests(reason);
    for (const reject of this.pendingWrites) reject(reason);
    this.releaseEncryption?.();
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.buffer = Buffer.alloc(0);
    this.inputKey = this.outputKey = undefined;
    this.inCounter = this.outCounter = 0n;
    this.encryptionReady = this.releaseEncryption = undefined;
    this.receiving = Promise.resolve();
    this.heartbeatInFlight = false;
    this.emit('close');
  }
}
