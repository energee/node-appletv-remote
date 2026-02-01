import { hkdf, createCipheriv, createDecipheriv, randomBytes, getCiphers } from 'node:crypto';
import { promisify } from 'node:util';

const hkdfAsync = promisify(hkdf);

const hasNativeChacha = getCiphers().includes('chacha20-poly1305');

let nobleChacha: typeof import('@noble/ciphers/chacha').chacha20poly1305 | undefined;
if (!hasNativeChacha) {
  const mod = await import('@noble/ciphers/chacha');
  nobleChacha = mod.chacha20poly1305;
}

export async function hkdfSha512(
  ikm: Buffer,
  salt: Buffer | string,
  info: Buffer | string,
  length: number,
): Promise<Buffer> {
  const derived = await hkdfAsync(
    'sha512',
    ikm,
    typeof salt === 'string' ? Buffer.from(salt) : salt,
    typeof info === 'string' ? Buffer.from(info) : info,
    length,
  );
  return Buffer.from(derived);
}

export function encryptChaCha20(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { ciphertext: Buffer; tag: Buffer } {
  if (hasNativeChacha) {
    const cipher = createCipheriv('chacha20-poly1305' as any, key, nonce, { authTagLength: 16 } as any);
    cipher.setAAD(aad, { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, tag };
  }

  const aead = nobleChacha!(key, nonce);
  const sealed = aead.encrypt(plaintext, aad);
  // noble returns ciphertext || tag (16 bytes)
  const ciphertext = Buffer.from(sealed.subarray(0, sealed.length - 16));
  const tag = Buffer.from(sealed.subarray(sealed.length - 16));
  return { ciphertext, tag };
}

export function decryptChaCha20(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  if (hasNativeChacha) {
    const decipher = createDecipheriv('chacha20-poly1305' as any, key, nonce, { authTagLength: 16 } as any);
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // noble expects ciphertext || tag
  const sealed = Buffer.concat([ciphertext, tag]);
  const aead = nobleChacha!(key, nonce);
  const plaintext = aead.decrypt(sealed, aad);
  return Buffer.from(plaintext);
}

export function generateNonce(counter: bigint, length: number = 12): Buffer {
  const nonce = Buffer.alloc(length, 0);
  nonce.writeBigUInt64LE(counter, length === 12 ? 4 : 0);
  return nonce;
}

export function generateRandomBytes(size: number): Buffer {
  return randomBytes(size);
}
