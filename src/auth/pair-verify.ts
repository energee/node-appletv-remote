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
import { PersistentHttp } from '../util/http.js';
import type { HAPCredentials } from './types.js';

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

export class PairVerify {
  private http: PersistentHttp;
  private credentials: HAPCredentials;
  private ephemeralPrivateKey: KeyObject;
  private ephemeralPublicKeyRaw: Buffer;

  constructor(host: string, port: number, credentials: HAPCredentials) {
    this.http = new PersistentHttp(host, port);
    this.credentials = credentials;

    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    this.ephemeralPrivateKey = privateKey;
    this.ephemeralPublicKeyRaw = Buffer.from(
      publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    );
  }

  buildM1(): Buffer {
    return tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x01]),
      [TlvTag.PublicKey]: this.ephemeralPublicKeyRaw,
    });
  }

  async verify(): Promise<{ outputKey: Buffer; inputKey: Buffer }> {
    // Step 1: Send M1
    const m1 = this.buildM1();
    const m2Body = await this.http.post('/pair-verify', m1);
    const m2 = tlvDecode(m2Body);

    const serverEphemeralPub = m2[TlvTag.PublicKey];
    const m2Encrypted = m2[TlvTag.EncryptedData];

    if (!serverEphemeralPub || !m2Encrypted) {
      const error = m2[TlvTag.Error];
      throw new Error(`M2 missing PublicKey or EncryptedData (error=${error ? error[0] : 'none'})`);
    }

    // Step 2: Compute shared secret via X25519
    const serverEphemeralKeyObj = x25519PublicKeyFromRaw(serverEphemeralPub);
    const sharedSecret = diffieHellman({
      privateKey: this.ephemeralPrivateKey,
      publicKey: serverEphemeralKeyObj,
    });

    // Step 3: Derive session key
    const sessionKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Pair-Verify-Encrypt-Salt',
      'Pair-Verify-Encrypt-Info',
      32,
    );

    // Step 4: Decrypt M2 encrypted data
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

    // Step 5: Verify server's Ed25519 signature
    const serverSignedData = Buffer.concat([
      serverEphemeralPub,
      serverIdentifier,
      this.ephemeralPublicKeyRaw,
    ]);

    const serverLTPKObj = ed25519PublicKeyFromRaw(this.credentials.serverLTPK);
    const valid = cryptoVerify(null, serverSignedData, serverLTPKObj, serverSignature);
    if (!valid) {
      throw new Error('Server signature verification failed');
    }

    // Step 6: Sign our proof
    const clientSignedData = Buffer.concat([
      this.ephemeralPublicKeyRaw,
      Buffer.from(this.credentials.clientId),
      serverEphemeralPub,
    ]);

    const clientPrivKey = ed25519PrivateKeyFromSeed(this.credentials.clientLTSK);
    const clientSignature = sign(null, clientSignedData, clientPrivKey);

    // Step 7: Build and encrypt M3 sub-TLV
    const subTlv = tlvEncode({
      [TlvTag.Identifier]: Buffer.from(this.credentials.clientId),
      [TlvTag.Signature]: clientSignature,
    });

    const m3Nonce = Buffer.alloc(12, 0);
    m3Nonce.write('PV-Msg03', 4);

    const { ciphertext, tag } = encryptChaCha20(sessionKey, m3Nonce, subTlv, Buffer.alloc(0));
    const encryptedData = Buffer.concat([ciphertext, tag]);

    // Step 8: Send M3
    const m3 = tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([0x03]),
      [TlvTag.EncryptedData]: encryptedData,
    });

    const m4Body = await this.http.post('/pair-verify', m3);
    const m4 = tlvDecode(m4Body);

    const m4Error = m4[TlvTag.Error];
    if (m4Error && m4Error[0] !== 0) {
      throw new Error(`Pair-verify M4 error: ${m4Error[0]}`);
    }

    // Step 9: Derive final encryption keys
    const outputKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Control-Salt',
      'Control-Write-Encryption-Key',
      32,
    );

    const inputKey = await hkdfSha512(
      Buffer.from(sharedSecret),
      'Control-Salt',
      'Control-Read-Encryption-Key',
      32,
    );

    this.http.destroy();
    return { outputKey, inputKey };
  }
}
