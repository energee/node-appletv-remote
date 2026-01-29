import { generateKeyPairSync, sign, createPrivateKey, randomUUID } from 'node:crypto';
import { TlvTag, tlvEncode, tlvDecode } from '../util/tlv.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from '../util/crypto.js';
import { SRPClient } from './srp.js';
import { PersistentHttp } from '../util/http.js';
import type { HAPCredentials } from './types.js';

export class PairSetup {
  private http: PersistentHttp;
  private clientId: string;
  private edPrivateKeyRaw: Buffer;
  private edPublicKeyRaw: Buffer;
  private srp = new SRPClient();
  private sessionKey: Buffer | undefined;

  constructor(host: string, port: number) {
    this.http = new PersistentHttp(host, port);
    this.clientId = randomUUID();

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.edPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );
    this.edPrivateKeyRaw = Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32),
    );
  }

  buildM1(): Buffer {
    return tlvEncode({
      [TlvTag.Method]: Buffer.from([0x00]),
      [TlvTag.SeqNo]: Buffer.from([0x01]),
    });
  }

  buildM3(publicKey: Buffer, proof: Buffer): Buffer {
    return tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.PublicKey]: publicKey,
      [TlvTag.Proof]: proof,
    });
  }

  async start(): Promise<void> {
    await this.http.post('/pair-pin-start', Buffer.alloc(0));
  }

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

    // Sign with Ed25519
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

    // Encrypt with ChaCha20-Poly1305
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

    // Decrypt M6
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

  async finish(pin: string): Promise<HAPCredentials> {
    try {
      const { salt, serverPublicKey } = await this.sendM1();
      await this.sendM3(pin, salt, serverPublicKey);
      return await this.sendM5();
    } finally {
      this.http.destroy();
    }
  }

  destroy(): void {
    this.http.destroy();
  }
}
