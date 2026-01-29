import { describe, it, expect } from 'vitest';
import { PairSetup } from '../pair-setup.js';

describe('PairSetup', () => {
  it('constructs with host and port', () => {
    const ps = new PairSetup('192.168.1.100', 7000);
    expect(ps).toBeDefined();
  });

  it('builds M1 TLV correctly', () => {
    const ps = new PairSetup('192.168.1.100', 7000);
    const m1 = ps.buildM1();
    expect(m1).toBeInstanceOf(Buffer);
    // Should contain at least Method and SeqNo tags
    expect(m1.length).toBeGreaterThanOrEqual(6);
  });

  it('builds M3 TLV with public key and proof', () => {
    const ps = new PairSetup('192.168.1.100', 7000);
    const pubKey = Buffer.alloc(384, 0x01);
    const proof = Buffer.alloc(64, 0x02);
    const m3 = ps.buildM3(pubKey, proof);
    expect(m3).toBeInstanceOf(Buffer);
    expect(m3.length).toBeGreaterThan(384 + 64);
  });
});
