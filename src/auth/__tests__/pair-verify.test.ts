import { describe, it, expect } from 'vitest';
import { PairVerify } from '../pair-verify.js';
import { randomBytes } from 'node:crypto';

describe('PairVerify', () => {
  it('constructs with host, port, and credentials', () => {
    const pv = new PairVerify('192.168.1.100', 7000, {
      clientId: 'test-id',
      clientLTSK: randomBytes(32),
      clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32),
      serverId: 'server-id',
    });
    expect(pv).toBeDefined();
  });

  it('generates an X25519 ephemeral keypair on construction', () => {
    const pv = new PairVerify('192.168.1.100', 7000, {
      clientId: 'test-id',
      clientLTSK: randomBytes(32),
      clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32),
      serverId: 'server-id',
    });
    const m1 = pv.buildM1();
    expect(m1).toBeInstanceOf(Buffer);
    expect(m1.length).toBeGreaterThan(32);
  });
});
