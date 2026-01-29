import { describe, it, expect } from 'vitest';
import { AppleTV } from '../appletv.js';
import { Credentials } from '../credentials.js';

describe('AppleTV', () => {
  it('creates from discovered device info', () => {
    const atv = new AppleTV({
      name: 'Living Room',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });
    expect(atv.name).toBe('Living Room');
    expect(atv.address).toBe('192.168.1.100');
  });

  it('has remote control methods', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });
    expect(typeof atv.up).toBe('function');
    expect(typeof atv.down).toBe('function');
    expect(typeof atv.left).toBe('function');
    expect(typeof atv.right).toBe('function');
    expect(typeof atv.select).toBe('function');
    expect(typeof atv.menu).toBe('function');
    expect(typeof atv.home).toBe('function');
    expect(typeof atv.playPause).toBe('function');
    expect(typeof atv.volumeUp).toBe('function');
    expect(typeof atv.volumeDown).toBe('function');
  });
});

describe('Credentials', () => {
  it('serializes and deserializes', () => {
    const creds = new Credentials({
      clientId: 'abc',
      clientLTSK: Buffer.alloc(32, 0x01),
      clientLTPK: Buffer.alloc(32, 0x02),
      serverLTPK: Buffer.alloc(32, 0x03),
      serverId: 'server',
    });
    const serialized = creds.serialize();
    const restored = Credentials.deserialize(serialized);
    expect(restored.clientId).toBe('abc');
    expect(restored.serverLTPK).toEqual(Buffer.alloc(32, 0x03));
  });
});
