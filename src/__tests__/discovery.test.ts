/** Tests for AirPlay TXT parsing, DiscoveredDevice construction and `_raop._tcp` joining in scan(). */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { parseAirPlayTxt, DiscoveredDevice, scan } from '../discovery.js';

// Fake Bonjour: each browsed type receives its synthetic services on a microtask.
const bonjour = vi.hoisted(() => ({ services: {} as Record<string, Record<string, unknown>[]> }));
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    find(options: { type: string }, found: (service: Record<string, unknown>) => void) {
      queueMicrotask(() => (bonjour.services[options.type] ?? []).forEach(found));
      return { stop() {} };
    }
    destroy() {}
  },
}));

beforeEach(() => { vi.useFakeTimers(); bonjour.services = {}; });
afterEach(() => vi.useRealTimers());

async function scanned(): Promise<DiscoveredDevice[]> {
  const pending = scan({ timeout: 10 });
  await vi.advanceTimersByTimeAsync(10);
  return pending;
}

describe('Discovery', () => {
  it('parses AirPlay TXT record fields', () => {
    const txt = {
      deviceid: 'AA:BB:CC:DD:EE:FF',
      features: '0x5A7FFFF7,0x1E',
      model: 'AppleTV6,2',
      pi: 'some-uuid',
    };
    const result = parseAirPlayTxt(txt);
    expect(result.deviceId).toBe('AA:BB:CC:DD:EE:FF');
    expect(result.model).toBe('AppleTV6,2');
  });

  it('creates a DiscoveredDevice from service info', () => {
    const device = new DiscoveredDevice({
      name: 'Living Room',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC:DD:EE:FF',
      model: 'AppleTV6,2',
    });
    expect(device.name).toBe('Living Room');
    expect(device.address).toBe('192.168.1.100');
    expect(device.port).toBe(7000);
  });
});

describe('_raop._tcp discovery', () => {
  it('joins a RAOP record to the AirPlay device whose deviceid MAC matches', async () => {
    bonjour.services = {
      airplay: [{ name: 'Living Room', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'AA:BB:CC:DD:EE:FF', model: 'AppleTV6,2' } }],
      // Different SRV host, no shared address, lowercase MAC without colons: only the MAC links it.
      raop: [{ name: 'aabbccddeeff@Living Room', host: 'other.local', addresses: ['192.0.2.20'], port: 7001, txt: { ft: '0x4A7FDFD5,0xBC157FDE', et: '0,4' } }],
    };
    const devices = await scanned();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ name: 'Living Room', port: 7000, deviceId: 'AA:BB:CC:DD:EE:FF', raopPort: 7001, raopAddress: '192.0.2.20' });
  });

  it('prefers a RAOP address shared with the AirPlay record', async () => {
    bonjour.services = {
      airplay: [{ name: 'TV', host: 'tv.local', addresses: ['192.0.2.10', '192.0.2.11'], port: 7000, txt: { deviceid: 'AA:BB:CC:DD:EE:FF' } }],
      raop: [{ name: 'AABBCCDDEEFF@TV', host: 'tv.local', addresses: ['192.0.2.99', '192.0.2.11'], port: 7000, txt: {} }],
    };
    expect((await scanned())[0].raopAddress).toBe('192.0.2.11');
  });

  it('keeps a RAOP record with a conflicting MAC separate even at the same host', async () => {
    bonjour.services = {
      airplay: [{ name: 'TV', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'AA:BB:CC:DD:EE:FF' } }],
      raop: [{ name: '112233445566@Other', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: {} }],
    };
    const devices = await scanned();
    expect(devices).toHaveLength(2);
    expect(devices.find(device => device.name === 'TV')?.raopPort).toBeUndefined();
  });

  it('keeps a RAOP-only receiver as its own device named after the @ suffix', async () => {
    bonjour.services = {
      airplay: [{ name: 'Living Room', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'AA:BB:CC:DD:EE:FF' } }],
      raop: [{ name: '112233445566@Kitchen Speaker', host: 'speaker.local', addresses: ['192.0.2.30'], port: 5000, txt: { am: 'AirPort10,115', cn: '0,1' } }],
    };
    const devices = await scanned();
    expect(devices).toHaveLength(2);
    expect(devices.find(device => device.name === 'Kitchen Speaker')).toMatchObject({
      address: '192.0.2.30', port: 0, deviceId: '11:22:33:44:55:66', model: 'AirPort10,115',
      raopPort: 5000, raopAddress: '192.0.2.30',
    });
    expect(devices.find(device => device.name === 'Living Room')?.raopPort).toBeUndefined();
  });

  it.each(['Kitchen Speaker', '11223344556@Kitchen', '11223344556G@Kitchen', '11:22:33:44:55:66@Kitchen'])(
    'ignores a malformed RAOP instance name %s', async name => {
      bonjour.services = { raop: [{ name, host: 'speaker.local', addresses: ['192.0.2.30'], port: 5000, txt: {} }] };
      expect(await scanned()).toEqual([]);
    });

  it('exposes the RAOP TXT record with lower-cased keys', async () => {
    bonjour.services = {
      raop: [{ name: '112233445566@Speaker', addresses: ['192.0.2.30'], port: 5000, txt: { CN: '0,1', Et: '0', sr: 44100 } }],
    };
    expect((await scanned())[0].raopTxt).toEqual({ cn: '0,1', et: '0', sr: '44100' });
  });
});
