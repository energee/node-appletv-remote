/**
 * HAP pair-setup (SRP-6a with the PIN shown on screen) for the AirPlay/MRP channel.
 * Runs M1–M6 over HTTP POST /pair-setup or an injected standalone MRP TLV carrier, returning long-term
 * credentials that PairVerify / AirPlayConnection use on later connections.
 */

import { generateKeyPairSync, sign, createPrivateKey, randomUUID } from 'node:crypto';
import { TlvTag, tlvEncode, tlvDecode } from '../util/tlv.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from '../util/crypto.js';
import { SRPClient } from './srp.js';
import { PersistentHttp } from '../util/http.js';
import type { HAPCredentials } from './types.js';

/**
 * Client side of one HAP pair-setup session. Call `start()` to make the Apple TV
 * show a PIN, then `finish(pin)`. Each instance has its own random client ID and
 * Ed25519 long-term key pair, which end up in the returned credentials.
 */
export class PairSetup {
  private http: Pick<PersistentHttp, 'post' | 'destroy'>;
  private clientId: string;
  private edPrivateKeyRaw: Buffer;
  private edPublicKeyRaw: Buffer;
  private srp = new SRPClient();
  private sessionKey: Buffer | undefined;

  /** Generate controller keys; use the provided TLV carrier or persistent AirPlay HTTP. */
  constructor(host: string, port: number, transport?: Pick<PersistentHttp, 'post' | 'destroy'>) {
    this.http = transport ?? new PersistentHttp(host, port);
    this.clientId = randomUUID();

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.edPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );
    this.edPrivateKeyRaw = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    );
  }

  /** M1: SRP start request (Method 0 = pair-setup, SeqNo 1). */
  buildM1(): Buffer {
    return tlvEncode({
      [TlvTag.Method]: Buffer.from([0x00]),
      [TlvTag.SeqNo]: Buffer.from([0x01]),
    });
  }

  /** M3: the SRP client public key A and proof M1. */
  buildM3(publicKey: Buffer, proof: Buffer): Buffer {
    return tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.PublicKey]: publicKey,
      [TlvTag.Proof]: proof,
    });
  }

  /** POST /pair-pin-start, which makes the Apple TV display the pairing PIN. */
  async start(): Promise<void> {
    await this.http.post('/pair-pin-start', Buffer.alloc(0));
  }

  /**
   * Send M1 and read M2.
   * @returns the SRP salt and server public key B from M2.
   * @throws if M2 lacks either field (the device's TLV error code is included).
   */
  async sendM1(): Promise<{ salt: Buffer; serverPublicKey: Buffer }> {
    const m1 = this.buildM1();
    const responseBody = await this.http.post('/pair-setup', m1);
    const m2 = tlvDecode(responseBody);

    const salt = m2[TlvTag.Salt];
    const serverPublicKey = m2[TlvTag.PublicKey];

    if (!salt || !serverPublicKey) {
      const error = m2[TlvTag.Error];
      throw new Error(`M2 missing Salt or PublicKey (error=${error ? error[0] : 'none'})`);
    }

    return { salt, serverPublicKey };
  }

  /**
   * Run SRP with the PIN, send M3, and verify the server proof in M4.
   * On success stores the SRP shared secret K for `sendM5`.
   * @throws if M4 has no proof (e.g. wrong PIN) or the proof fails verification.
   */
  async sendM3(
    pin: string,
    salt: Buffer,
    serverPublicKey: Buffer,
  ): Promise<void> {
    this.srp.init(salt, pin);
    this.srp.setServerPublicKey(serverPublicKey);

    const clientPublicKey = this.srp.getPublicKey();
    const proof = this.srp.computeProof();

    const m3 = this.buildM3(clientPublicKey, proof);
    const responseBody = await this.http.post('/pair-setup', m3);
    const m4 = tlvDecode(responseBody);

    const serverProof = m4[TlvTag.Proof];
    if (!serverProof) {
      const error = m4[TlvTag.Error];
      throw new Error(`M4 missing Proof (error=${error ? error[0] : 'none'})`);
    }

    this.srp.verifyServerProof(serverProof);
    this.sessionKey = this.srp.getSharedSecret();
  }

  /**
   * Send our encrypted long-term identity (M5) and decrypt the Apple TV's (M6).
   * @returns credentials pairing our Ed25519 keys with the device's ID and public key.
   * @throws if called before `sendM3`, or if M6 is missing or malformed.
   */
  async sendM5(): Promise<HAPCredentials> {
    if (!this.sessionKey) {
      throw new Error('Session key not available; call sendM3 first');
    }

    // Derive signing and encryption keys
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

    // Build device info to sign: signingKey + clientId + edPublicKey
    const clientIdBuf = Buffer.from(this.clientId);
    const deviceInfo = Buffer.concat([signingKey, clientIdBuf, this.edPublicKeyRaw]);

    // Sign with Ed25519 (raw 32-byte seed wrapped in a PKCS#8 DER prefix)
    const edKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        this.edPrivateKeyRaw,
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = sign(null, deviceInfo, edKey);

    // Build sub-TLV for encrypted data
    const subTlv = tlvEncode({
      [TlvTag.Identifier]: clientIdBuf,
      [TlvTag.PublicKey]: this.edPublicKeyRaw,
      [TlvTag.Signature]: signature,
    });

    // Encrypt with ChaCha20-Poly1305; the 12-byte nonce is 4 zero bytes + "PS-Msg05"
    const nonce = Buffer.alloc(12, 0);
    nonce.write('PS-Msg05', 4);

    const { ciphertext, tag } = encryptChaCha20(
      encryptionKey,
      nonce,
      subTlv,
      Buffer.alloc(0),
    );

    const encryptedData = Buffer.concat([ciphertext, tag]);

    // Build M5 TLV
    const m5 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x05]),
      [TlvTag.EncryptedData]: encryptedData,
    });

    const responseBody = await this.http.post('/pair-setup', m5);
    const m6 = tlvDecode(responseBody);

    const m6Encrypted = m6[TlvTag.EncryptedData];
    if (!m6Encrypted) {
      const error = m6[TlvTag.Error];
      throw new Error(`M6 missing EncryptedData (error=${error ? error[0] : 'none'})`);
    }

    // Decrypt M6; the last 16 bytes are the Poly1305 auth tag
    const m6Nonce = Buffer.alloc(12, 0);
    m6Nonce.write('PS-Msg06', 4);

    const m6Ciphertext = m6Encrypted.subarray(0, m6Encrypted.length - 16);
    const m6Tag = m6Encrypted.subarray(m6Encrypted.length - 16);

    const decrypted = decryptChaCha20(
      encryptionKey,
      m6Nonce,
      m6Ciphertext,
      m6Tag,
      Buffer.alloc(0),
    );

    const serverInfo = tlvDecode(decrypted);
    const serverId = serverInfo[TlvTag.Identifier];
    const serverLTPK = serverInfo[TlvTag.PublicKey];

    if (!serverId || !serverLTPK) {
      throw new Error('M6 decrypted data missing Identifier or PublicKey');
    }

    return {
      clientId: this.clientId,
      clientLTSK: this.edPrivateKeyRaw,
      clientLTPK: this.edPublicKeyRaw,
      serverLTPK,
      serverId: serverId.toString('utf-8'),
    };
  }

  /** Run M1 through M6 with the given PIN, then close the HTTP connection whether or not it succeeded. */
  async finish(pin: string): Promise<HAPCredentials> {
    try {
      const { salt, serverPublicKey } = await this.sendM1();
      await this.sendM3(pin, salt, serverPublicKey);
      return await this.sendM5();
    } finally {
      this.http.destroy();
    }
  }

  /** Close the HTTP connection without completing pairing. */
  destroy(): void {
    this.http.destroy();
  }
}
