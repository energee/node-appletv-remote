import { describe, it, expect } from 'vitest';
import { CompanionSession } from '../companion-session.js';
import { FrameType } from '../framing.js';
import { generateRandomBytes } from '../../util/crypto.js';

describe('CompanionSession', () => {
  function createSessionPair() {
    const key1 = generateRandomBytes(32);
    const key2 = generateRandomBytes(32);
    // Two sessions: one encrypts with key1, decrypts with key2; the other reverses
    const sender = new CompanionSession(key1, key2);
    const receiver = new CompanionSession(key2, key1);
    return { sender, receiver };
  }

  it('encrypts and decrypts a payload', () => {
    const { sender, receiver } = createSessionPair();
    const plaintext = Buffer.from('hello companion');

    const encrypted = sender.encrypt(FrameType.E_OPACK, plaintext);

    // Encrypted output: 4-byte header + ciphertext + 16-byte tag
    const header = encrypted.subarray(0, 4);
    expect(header[0]).toBe(FrameType.E_OPACK);
    // Length in header should be plaintext length
    const payloadLen = (header[1] << 16) | (header[2] << 8) | header[3];
    expect(payloadLen).toBe(plaintext.length);

    const encryptedPayload = encrypted.subarray(4);
    const decrypted = receiver.decrypt(header, encryptedPayload);
    expect(decrypted).toEqual(plaintext);
  });

  it('handles multiple sequential messages with incrementing counters', () => {
    const { sender, receiver } = createSessionPair();

    for (let i = 0; i < 5; i++) {
      const msg = Buffer.from(`message ${i}`);
      const encrypted = sender.encrypt(FrameType.E_OPACK, msg);
      const header = encrypted.subarray(0, 4);
      const payload = encrypted.subarray(4);
      const decrypted = receiver.decrypt(header, payload);
      expect(decrypted).toEqual(msg);
    }
  });

  it('fails to decrypt with wrong key', () => {
    const key1 = generateRandomBytes(32);
    const key2 = generateRandomBytes(32);
    const key3 = generateRandomBytes(32);
    const sender = new CompanionSession(key1, key2);
    const wrongReceiver = new CompanionSession(key2, key3); // key3 != key1, so decrypt fails

    const encrypted = sender.encrypt(FrameType.E_OPACK, Buffer.from('secret'));
    const header = encrypted.subarray(0, 4);
    const payload = encrypted.subarray(4);

    expect(() => wrongReceiver.decrypt(header, payload)).toThrow();
  });
});
