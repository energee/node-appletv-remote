import { encryptChaCha20, decryptChaCha20 } from './crypto.js';

/**
 * ChaCha20-Poly1305 cipher with 8-byte nonce for MRP-level encryption.
 * Unlike HAPSession (which uses 12-byte nonces with 2-byte length prefix framing),
 * this cipher uses 8-byte nonces and operates on raw protobuf data without framing.
 */
export class MRPCipher {
  private outCounter = 0n;
  private inCounter = 0n;

  constructor(
    private outKey: Buffer,
    private inKey: Buffer,
  ) {}

  encrypt(data: Buffer): Buffer {
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(this.outCounter);
    this.outCounter++;

    // 12-byte nonce for chacha20-poly1305: pad 8-byte nonce to 12
    const nonce12 = Buffer.alloc(12, 0);
    nonce.copy(nonce12, 4);

    const { ciphertext, tag } = encryptChaCha20(
      this.outKey,
      nonce12,
      data,
      Buffer.alloc(0),
    );

    return Buffer.concat([ciphertext, tag]);
  }

  decrypt(data: Buffer): Buffer {
    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(this.inCounter);
    this.inCounter++;

    const nonce12 = Buffer.alloc(12, 0);
    nonce.copy(nonce12, 4);

    const ciphertext = data.subarray(0, data.length - 16);
    const tag = data.subarray(data.length - 16);

    return decryptChaCha20(
      this.inKey,
      nonce12,
      ciphertext,
      tag,
      Buffer.alloc(0),
    );
  }
}
