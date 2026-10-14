/**
 * Cryptographic primitives shared by the AirPlay, pairing, and Companion layers:
 * HKDF-SHA512 key derivation and ChaCha20-Poly1305 AEAD, using Node's native cipher
 * when available and falling back to @noble/ciphers otherwise.
 */

import { hkdf, createCipheriv, createDecipheriv, randomBytes, getCiphers } from 'node:crypto';
import { promisify } from 'node:util';

const hkdfAsync = promisify(hkdf);

/** Whether this Node/OpenSSL build exposes `chacha20-poly1305` natively. */
const hasNativeChacha = getCiphers().includes('chacha20-poly1305');

/** Pure-JS ChaCha20-Poly1305, loaded (via top-level await) only when the native cipher is missing. */
let nobleChacha: typeof import('@noble/ciphers/chacha').chacha20poly1305 | undefined;
if (!hasNativeChacha) {
  const mod = await import('@noble/ciphers/chacha');
  nobleChacha = mod.chacha20poly1305;
}

/**
 * Derive `length` bytes with HKDF-SHA512. String salt/info are UTF-8 encoded,
 * matching the ASCII labels (e.g. "Control-Salt") used by HAP and AirPlay.
 */
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

/**
 * ChaCha20-Poly1305 encrypt with a 16-byte tag. Returns ciphertext and tag separately;
 * callers append the tag themselves when the wire format requires it.
 */
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

  const aead = nobleChacha!(key, nonce, aad);
  const sealed = aead.encrypt(plaintext);
  // noble returns ciphertext || tag (16 bytes)
  const ciphertext = Buffer.from(sealed.subarray(0, sealed.length - 16));
  const tag = Buffer.from(sealed.subarray(sealed.length - 16));
  return { ciphertext, tag };
}

/**
 * ChaCha20-Poly1305 decrypt with a separately supplied 16-byte tag.
 * @throws if authentication fails (bad key, nonce, AAD, or tampered data).
 */
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
  const aead = nobleChacha!(key, nonce, aad);
  const plaintext = aead.decrypt(sealed);
  return Buffer.from(plaintext);
}

/**
 * Build a counter nonce. For the default 12-byte length the 64-bit little-endian counter
 * fills bytes 4-11 (4 leading zero bytes, as HAP sessions use); for any other length it is
 * written at offset 0, so `length` must be at least 8.
 */
export function generateNonce(counter: bigint, length: number = 12): Buffer {
  const nonce = Buffer.alloc(length, 0);
  nonce.writeBigUInt64LE(counter, length === 12 ? 4 : 0);
  return nonce;
}

/** Cryptographically secure random bytes (thin wrapper over `crypto.randomBytes`). */
export function generateRandomBytes(size: number): Buffer {
  return randomBytes(size);
}
