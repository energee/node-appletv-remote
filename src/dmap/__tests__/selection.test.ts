/** Public protocol selection must not mistake legacy AirPlay for modern MRP. */
import { describe, expect, it } from 'vitest';
import { createClient, DmapClient, AppleTV } from '../../index.js';
const legacy = { name: 'TV', address: '127.0.0.1', port: 7000, dmapPort: 3689, deviceId: 'tv', model: 'AppleTV3,2' };
it('selects DMAP when discovered and allows explicit modern selection', () => {
  expect(createClient(legacy)).toBeInstanceOf(DmapClient);
  expect(createClient(legacy, 'airplay')).toBeInstanceOf(AppleTV);
});
describe('missing advertised protocol', () => {
  it('rejects requested DMAP without a DMAP port', () => expect(() => createClient({ ...legacy, dmapPort: undefined }, 'dmap')).toThrow(/DMAP/));
  it('rejects modern selection on a DMAP-only device', () => expect(() => createClient({ ...legacy, port: 0 }, 'airplay')).toThrow(/AirPlay/));
});

it('rejects direct modern pairing on a DMAP-only device', async () => {
  const tv = new AppleTV({ ...legacy, port: 0 });
  await expect(tv.startPairing()).rejects.toThrow(/DMAP/);
});

it('prefers modern AirPlay over DMAP and enabled standalone MRP over legacy AirPlay', () => {
  expect(createClient({ ...legacy, model: 'AppleTV6,2', mrpPort: 49152 })).toBeInstanceOf(AppleTV);
  const standalone = createClient({ ...legacy, mrpPort: 49152, mrpEnabled: true });
  expect(standalone).toBeInstanceOf(AppleTV);
  expect((standalone as AppleTV).port).toBe(0);
  expect(createClient({ ...legacy, mrpPort: 49152, mrpEnabled: false })).toBeInstanceOf(DmapClient);
});
it('rejects explicit standalone MRP when disabled and allows it without AirPlay', () => {
  expect(() => createClient({ ...legacy, mrpPort: 49152, mrpEnabled: false }, 'mrp')).toThrow(/enabled standalone MRP/);
  expect(createClient({ ...legacy, port: 0, mrpPort: 49152 }, 'mrp')).toBeInstanceOf(AppleTV);
});

it('selects AppleTV for a Companion-only device but still rejects explicit AirPlay (#19)', () => {
  const companionOnly = { name: 'TV', address: '127.0.0.1', port: 0, companionPort: 49153, deviceId: 'tv', model: 'AppleTV11,1' };
  const tv = createClient(companionOnly);
  expect(tv).toBeInstanceOf(AppleTV);
  expect((tv as AppleTV).companionPort).toBe(49153);
  expect(() => createClient(companionOnly, 'airplay')).toThrow(/AirPlay/);
});

it('rejects unknown protocol overrides at runtime instead of silently selecting AirPlay', () => {
  expect(() => createClient(legacy, 'typo' as 'airplay')).toThrow(/protocol/i);
});
