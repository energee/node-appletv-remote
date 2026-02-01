/**
 * Companion protocol pair-setup.
 * Same SRP flow as AirPlay pair-setup but over Companion frames (PS_Start/PS_Next).
 * Key difference from AirPlay: TLV pairing data is wrapped in OPACK dicts under
 * the `_pd` key, and frames use PS_Start for M1, PS_Next for all subsequent messages.
 */

import { Socket } from 'node:net';
import { generateKeyPairSync, sign, createPrivateKey, randomUUID } from 'node:crypto';
import { TlvTag, tlvEncode, tlvDecode } from '../util/tlv.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from '../util/crypto.js';
import { SRPClient } from '../auth/srp.js';
import { FrameType, encodeFrame, parseFrames, type Frame } from './framing.js';
import { opackEncode, opackDecode, type OpackDict, type OpackValue } from './opack.js';
import type { HAPCredentials } from '../auth/types.js';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class CompanionPairSetup {
  private socket: Socket | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private clientId: string;
  private edPrivateKeyRaw: Buffer;
  private edPublicKeyRaw: Buffer;
  private srp = new SRPClient();
  private sessionKey: Buffer | undefined;
  private isFirstMessage = true;
  private xid = 0;
  private salt: Buffer | undefined;
  private serverPublicKey: Buffer | undefined;

  /** Queued frames that arrived before anyone was waiting for them. */
  private frameQueue: Frame[] = [];
  private pendingFrameResolvers: Array<(frame: Frame) => void> = [];

  constructor(
    private host: string,
    private port: number,
  ) {
    this.clientId = randomUUID();

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.edPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );
    this.edPrivateKeyRaw = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    );
  }

  /**
   * Open socket and send M1. The Apple TV should display the PIN after this.
   * Call finish(pin) after the user reads the PIN.
   */
  async start(): Promise<void> {
    await this.openSocket();
    const { salt, serverPublicKey } = await this.sendM1();
    this.salt = salt;
    this.serverPublicKey = serverPublicKey;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();
      this.socket.connect(this.port, this.host, () => {
        this.socket!.setNoDelay(true);
        resolve();
      });
      this.socket.on('error', (err) => {
        reject(err);
      });
      this.socket.on('data', (data: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, data]);
        this.processFrames();
      });
    });
  }

  /**
   * Send TLV pairing data wrapped in OPACK.
   * First message uses PS_Start with _pwTy=1 (PIN-based pairing),
   * all subsequent use PS_Next.
   */
  private sendPairingData(tlvData: Buffer): void {
    const frameType = this.isFirstMessage ? FrameType.PS_Start : FrameType.PS_Next;
    this.isFirstMessage = false;

    const opackPayload = new Map<OpackValue, OpackValue>([
      ['_pd', tlvData],
      ['_pwTy', 1],
      ['_x', this.xid++],
    ]);

    this.writeFrame(frameType, opackEncode(opackPayload));
  }

  /**
   * Receive TLV pairing data from an OPACK-wrapped response.
   */
  private async receivePairingData(): Promise<Buffer> {
    const frame = await this.waitForAnyFrame();
    const decoded = opackDecode(frame.payload);
    if (!(decoded instanceof Map)) {
      throw new Error(`Companion PS: expected OPACK dict response, got frame type 0x${frame.type.toString(16)}`);
    }
    const pd = (decoded as OpackDict).get('_pd');
    if (!Buffer.isBuffer(pd)) {
      const keys: string[] = [];
      for (const [k] of decoded as OpackDict) {
        keys.push(String(k));
      }
      throw new Error(`Companion PS: response missing _pd data (keys: ${keys.join(', ')}, frame type: 0x${frame.type.toString(16)})`);
    }
    return pd;
  }

  async sendM1(): Promise<{ salt: Buffer; serverPublicKey: Buffer }> {
    const m1 = tlvEncode({
      [TlvTag.Method]: Buffer.from([0x00]),
      [TlvTag.SeqNo]: Buffer.from([0x01]),
    });
    this.sendPairingData(m1);

    const m2Data = await this.receivePairingData();
    const m2 = tlvDecode(m2Data);

    const salt = m2[TlvTag.Salt];
    const serverPublicKey = m2[TlvTag.PublicKey];
    if (!salt || !serverPublicKey) {
      const error = m2[TlvTag.Error];
      throw new Error(`Companion PS M2 missing Salt or PublicKey (error=${error ? error[0] : 'none'})`);
    }

    return { salt, serverPublicKey };
  }

  async sendM3(pin: string, salt: Buffer, serverPublicKey: Buffer): Promise<void> {
    this.srp.init(salt, pin);
    this.srp.setServerPublicKey(serverPublicKey);

    const clientPublicKey = this.srp.getPublicKey();
    const proof = this.srp.computeProof();

    const m3 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.PublicKey]: clientPublicKey,
      [TlvTag.Proof]: proof,
    });
    this.sendPairingData(m3);

    const m4Data = await this.receivePairingData();
    const m4 = tlvDecode(m4Data);

    const serverProof = m4[TlvTag.Proof];
    if (!serverProof) {
      const error = m4[TlvTag.Error];
      throw new Error(`Companion PS M4 missing Proof (error=${error ? error[0] : 'none'})`);
    }

    this.srp.verifyServerProof(serverProof);
    this.sessionKey = this.srp.getSharedSecret();
  }

  async sendM5(): Promise<HAPCredentials> {
    if (!this.sessionKey) {
      throw new Error('Session key not available; call sendM3 first');
    }

    const signingKey = await hkdfSha512(
      this.sessionKey,
      'Pair-Setup-Controller-Sign-Salt',
      'Pair-Setup-Controller-Sign-Info',
      32,
    );

    const encryptionKey = await hkdfSha512(
      this.sessionKey,
      'Pair-Setup-Encrypt-Salt',
      'Pair-Setup-Encrypt-Info',
      32,
    );

    const clientIdBuf = Buffer.from(this.clientId);
    const deviceInfo = Buffer.concat([signingKey, clientIdBuf, this.edPublicKeyRaw]);

    const edKey = createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, this.edPrivateKeyRaw]),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = sign(null, deviceInfo, edKey);

    const subTlv = tlvEncode({
      [TlvTag.Identifier]: clientIdBuf,
      [TlvTag.PublicKey]: this.edPublicKeyRaw,
      [TlvTag.Signature]: signature,
    });

    const nonce = Buffer.alloc(12, 0);
    nonce.write('PS-Msg05', 4);
    const { ciphertext, tag } = encryptChaCha20(encryptionKey, nonce, subTlv, Buffer.alloc(0));
    const encryptedData = Buffer.concat([ciphertext, tag]);

    const m5 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x05]),
      [TlvTag.EncryptedData]: encryptedData,
    });
    this.sendPairingData(m5);

    const m6Data = await this.receivePairingData();
    const m6 = tlvDecode(m6Data);

    const m6Encrypted = m6[TlvTag.EncryptedData];
    if (!m6Encrypted) {
      const error = m6[TlvTag.Error];
      throw new Error(`Companion PS M6 missing EncryptedData (error=${error ? error[0] : 'none'})`);
    }

    const m6Nonce = Buffer.alloc(12, 0);
    m6Nonce.write('PS-Msg06', 4);
    const m6Ciphertext = m6Encrypted.subarray(0, m6Encrypted.length - 16);
    const m6Tag = m6Encrypted.subarray(m6Encrypted.length - 16);
    const decrypted = decryptChaCha20(encryptionKey, m6Nonce, m6Ciphertext, m6Tag, Buffer.alloc(0));

    const serverInfo = tlvDecode(decrypted);
    const serverId = serverInfo[TlvTag.Identifier];
    const serverLTPK = serverInfo[TlvTag.PublicKey];
    if (!serverId || !serverLTPK) {
      throw new Error('Companion PS M6 missing Identifier or PublicKey');
    }

    return {
      clientId: this.clientId,
      clientLTSK: this.edPrivateKeyRaw,
      clientLTPK: this.edPublicKeyRaw,
      serverLTPK,
      serverId: serverId.toString('utf-8'),
    };
  }

  /**
   * Complete pairing with the PIN displayed on the Apple TV.
   * start() must have been called first (sends M1, receives M2).
   */
  async finish(pin: string): Promise<HAPCredentials> {
    if (!this.salt || !this.serverPublicKey) {
      throw new Error('start() must be called before finish()');
    }
    try {
      await this.sendM3(pin, this.salt, this.serverPublicKey);
      return await this.sendM5();
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private writeFrame(type: FrameType, payload: Buffer): void {
    const frame = encodeFrame(type, payload);
    this.socket?.write(frame);
  }

  private waitForAnyFrame(timeoutMs = 10000): Promise<Frame> {
    if (this.frameQueue.length > 0) {
      return Promise.resolve(this.frameQueue.shift()!);
    }

    return new Promise((resolve, reject) => {
      const onFrame = (frame: Frame): void => {
        clearTimeout(timer);
        resolve(frame);
      };

      const timer = setTimeout(() => {
        const idx = this.pendingFrameResolvers.indexOf(onFrame);
        if (idx >= 0) this.pendingFrameResolvers.splice(idx, 1);
        reject(new Error('Companion PS timeout waiting for response frame'));
      }, timeoutMs);

      this.pendingFrameResolvers.push(onFrame);
      this.processFrames();
    });
  }

  private processFrames(): void {
    const { frames, remainder } = parseFrames(this.buffer);
    this.buffer = remainder;

    for (const frame of frames) {
      const resolver = this.pendingFrameResolvers.shift();
      if (resolver) {
        resolver(frame);
      } else {
        this.frameQueue.push(frame);
      }
    }
  }
}
