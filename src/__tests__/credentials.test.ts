import { describe, it, expect } from 'vitest';
import { Credentials, parseCredentials } from '../credentials.js';

describe('parseCredentials', () => {
  it('is a convenience wrapper for Credentials.deserialize', () => {
    const creds = new Credentials({
      clientId: 'abc',
      clientLTSK: Buffer.alloc(32, 0x01),
      clientLTPK: Buffer.alloc(32, 0x02),
      serverLTPK: Buffer.alloc(32, 0x03),
      serverId: 'server',
    });
    const serialized = creds.serialize();
    const restored = parseCredentials(serialized);
    expect(restored.clientId).toBe('abc');
    expect(restored.serverId).toBe('server');
    expect(restored.serverLTPK).toEqual(Buffer.alloc(32, 0x03));
  });
});
