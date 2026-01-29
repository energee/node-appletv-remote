import { describe, it, expect } from 'vitest';
import { parseAirPlayTxt, DiscoveredDevice } from '../discovery.js';

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
