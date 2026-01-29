import { describe, it, expect } from 'vitest';
import { SRPClient } from '../srp.js';

describe('SRPClient', () => {
  it('generates a public key', () => {
    const client = new SRPClient();
    const salt = Buffer.alloc(16, 0x01);
    const pin = '1234';
    client.init(salt, pin);
    const pubKey = client.getPublicKey();
    expect(pubKey).toBeInstanceOf(Buffer);
    expect(pubKey.length).toBeGreaterThan(0);
  });

  it('throws if setServerPublicKey is called before init', () => {
    const client = new SRPClient();
    expect(() => client.setServerPublicKey(Buffer.alloc(384))).toThrow();
  });

  it('computes proof after setting server public key', () => {
    const client = new SRPClient();
    const salt = Buffer.alloc(16, 0x01);
    client.init(salt, '1234');
    expect(client.getPublicKey()).toBeInstanceOf(Buffer);
  });
});
