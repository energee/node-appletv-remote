import { describe, it, expect } from 'vitest';
import { HAPSession } from '../hap-session.js';

describe('HAPSession', () => {
  it('encrypts and decrypts a short message', () => {
    const outKey = Buffer.alloc(32, 0x01);
    const inKey = Buffer.alloc(32, 0x01);
    const sender = new HAPSession(outKey, inKey);
    const receiver = new HAPSession(inKey, outKey);

    const plaintext = Buffer.from('hello');
    const encrypted = sender.encrypt(plaintext);
    const decrypted = receiver.decrypt(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it('encrypts and decrypts data larger than frame size (1024 bytes)', () => {
    const outKey = Buffer.alloc(32, 0x02);
    const inKey = Buffer.alloc(32, 0x02);
    const sender = new HAPSession(outKey, inKey);
    const receiver = new HAPSession(inKey, outKey);

    const plaintext = Buffer.alloc(3000, 0xaa);
    const encrypted = sender.encrypt(plaintext);
    const decrypted = receiver.decrypt(encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  it('handles sequential messages with incrementing nonces', () => {
    const outKey = Buffer.alloc(32, 0x03);
    const inKey = Buffer.alloc(32, 0x03);
    const sender = new HAPSession(outKey, inKey);
    const receiver = new HAPSession(inKey, outKey);

    for (let i = 0; i < 5; i++) {
      const msg = Buffer.from(`message ${i}`);
      const enc = sender.encrypt(msg);
      const dec = receiver.decrypt(enc);
      expect(dec).toEqual(msg);
    }
  });
});
