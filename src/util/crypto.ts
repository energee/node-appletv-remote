import { hkdf, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const hkdfAsync = promisify(hkdf);

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
  const cipher = createCipheriv('chacha20-poly1305', key, nonce, {
    authTagLength: 16,
  } as any);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, tag };
}

export function decryptChaCha20(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
    authTagLength: 16,
  } as any);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function generateNonce(counter: bigint, length: number = 12): Buffer {
  const nonce = Buffer.alloc(length, 0);
  nonce.writeBigUInt64LE(counter, length === 12 ? 4 : 0);
  return nonce;
}

export function generateRandomBytes(size: number): Buffer {
  return randomBytes(size);
}
