import { describe, it, expect } from 'vitest';
import { hkdfSha512, encryptChaCha20, decryptChaCha20 } from '../crypto.js';

describe('Crypto utilities', () => {
  it('derives a 32-byte key via HKDF-SHA512', async () => {
    const ikm = Buffer.from('input key material');
    const salt = Buffer.from('salt');
    const info = Buffer.from('info');
    const key = await hkdfSha512(ikm, salt, info, 32);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('HKDF is deterministic', async () => {
    const ikm = Buffer.from('test');
    const salt = Buffer.from('salt');
    const info = Buffer.from('info');
    const k1 = await hkdfSha512(ikm, salt, info, 32);
    const k2 = await hkdfSha512(ikm, salt, info, 32);
    expect(k1).toEqual(k2);
  });

  it('encrypts and decrypts with ChaCha20-Poly1305', () => {
    const key = Buffer.alloc(32, 0x42);
    const nonce = Buffer.alloc(12, 0x00);
    const plaintext = Buffer.from('hello world');
    const aad = Buffer.alloc(0);

    const { ciphertext, tag } = encryptChaCha20(key, nonce, plaintext, aad);
    const decrypted = decryptChaCha20(key, nonce, ciphertext, tag, aad);
    expect(decrypted).toEqual(plaintext);
  });

  it('decryption fails with wrong key', () => {
    const key = Buffer.alloc(32, 0x42);
    const wrongKey = Buffer.alloc(32, 0x43);
    const nonce = Buffer.alloc(12, 0x00);
    const plaintext = Buffer.from('secret');
    const aad = Buffer.alloc(0);

    const { ciphertext, tag } = encryptChaCha20(key, nonce, plaintext, aad);
    expect(() => decryptChaCha20(wrongKey, nonce, ciphertext, tag, aad)).toThrow();
  });
});
