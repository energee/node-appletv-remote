/** Regression tests for independent service discovery and stable dual-stack identities. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scan } from '../discovery.js';
const callbacks = vi.hoisted(() => new Map<string, (s: object) => void>());
vi.mock('bonjour-service', () => ({ Bonjour: class {
  find(o: { type: string }, cb: (s: object) => void) { callbacks.set(o.type, cb); return { stop() {} }; }
  destroy() {}
} }));
beforeEach(() => { vi.useFakeTimers(); callbacks.clear(); });
afterEach(() => vi.useRealTimers());
it('discovers Companion alone without inventing AirPlay support', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('companion-link')!({ name: 'TV', host: 'tv.local', addresses: ['fd00::10'], port: 49153, txt: { rpMRtID: 'stable', rpMd: 'AppleTV6,2' } });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject([{ deviceId: 'stable', address: 'fd00::10', port: 0, companionPort: 49153, model: 'AppleTV6,2' }]);
});
for (const order of [['airplay', 'companion-link'], ['companion-link', 'airplay']]) {
  it(`merges mixed-family records independently of ${order[0]} arrival order`, async () => {
    const pending = scan({ timeout: 10 });
    const records: Record<string, object> = {
      airplay: { name: 'TV', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'mac' } },
      'companion-link': { name: 'TV', host: 'tv.local', addresses: ['fd00::10'], port: 49153, txt: { rpmrtid: 'stable' } },
    };
    for (const type of order) callbacks.get(type)!(records[type]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toMatchObject([{ deviceId: 'mac', port: 7000, companionPort: 49153, identifiers: ['mac', 'stable'] }]);
  });
}
it('exposes the AirPlay psi as the output-routing identifier', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'Speaker', addresses: ['192.0.2.40'], port: 7000, txt: { deviceid: 'DA:92:F3:26:15:13', pi: 'dea389db-fc26-4277-901c-acff208c0b18', psi: 'DA92F326-1513-45C3-8B1D-25E95F4DC7F2' } });
  await vi.advanceTimersByTimeAsync(10);
  expect((await pending)[0]?.airplayPsi).toBe('DA92F326-1513-45C3-8B1D-25E95F4DC7F2');
});
it('leaves airplayPsi undefined when it is not advertised', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'TV', addresses: ['192.0.2.41'], port: 7000, txt: { deviceid: 'id' } });
  await vi.advanceTimersByTimeAsync(10);
  expect((await pending)[0]).toHaveProperty('airplayPsi', undefined);
});
it('discovers legacy MRP and disables standalone transport for tvOS 15+', async () => {
  const pending = scan({ timeout: 10 });
  expect(callbacks.has('mediaremotetv')).toBe(true);
  callbacks.get('mediaremotetv')!({ name: 'old', addresses: ['fd00::20'], port: 49152, txt: { UniqueIdentifier: 'old-id', Name: 'Old TV', SystemBuildVersion: '18K802' } });
  callbacks.get('mediaremotetv')!({ name: 'new', addresses: ['fd00::21'], port: 49154, txt: { UniqueIdentifier: 'new-id', Name: 'New TV', SystemBuildVersion: '19J346' } });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject([{ deviceId: 'new-id', port: 0, mrpEnabled: false }, { deviceId: 'old-id', mrpPort: 49152, mrpEnabled: true }]);
});
it('does not treat known non-TV Companion advertisers as Apple TVs', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('companion-link')!({ name: 'Phone', addresses: ['fd00::9'], port: 1234, txt: { rpmd: 'iPhone15,2', rpmrtid: 'phone' } });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toEqual([]);
});
it('rejects unscoped link-local IPv6 and keeps scoped addresses', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'TV', addresses: ['::', '::1', 'fe80::1', 'fe80::2%en0'], port: 7000, txt: { deviceid: 'id' } });
  await vi.advanceTimersByTimeAsync(10);
  expect((await pending)[0]?.address).toBe('fe80::2%en0');
});

for (const order of [['airplay', 'touch-able'], ['touch-able', 'airplay']]) {
  it(`merges DMAP on a shared IPv6 endpoint when ${order[0]} arrives first`, async () => {
    const pending = scan({ timeout: 10 });
    const records: Record<string, object> = {
      'touch-able': { name: 'legacy-id', host: 'tv.local', addresses: ['fd00::30'], port: 3689, txt: { CtlN: 'Living Room' } },
      airplay: { name: 'Living Room', host: 'tv.local', addresses: ['192.0.2.30', 'fd00::30'], port: 7000, txt: { deviceid: 'mac', model: 'AppleTV3,2' } },
    };
    for (const type of order) callbacks.get(type)!(records[type]);
    await vi.advanceTimersByTimeAsync(10);
    const devices = await pending;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceId: 'mac', address: '192.0.2.30', port: 7000, dmapPort: 3689, dmapAddress: 'fd00::30', identifiers: ['mac', 'dmap:legacy-id'] });
  });
}
it('does not expose DMAP Home Sharing credentials as device identifiers', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('appletv-v2')!({ name: 'legacy-id', addresses: ['192.0.2.40'], port: 3689, txt: { Name: 'TV', hGID: 'private-home-sharing-id' } });
  await vi.advanceTimersByTimeAsync(10);
  expect((await pending)[0].identifiers).toEqual(['dmap:legacy-id']);
});

for (const type of ['touch-able', 'appletv-v2']) {
  for (const dmapFirst of [false, true]) {
    it(`does not accept a ${type} instance name as an AirPlay ID (DMAP first: ${dmapFirst})`, async () => {
      const pending = scan({ timeout: 10 });
      const records: [string, object][] = [
        ['airplay', { name: 'TV', host: 'tv.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'AA:BB:CC:DD:EE:FF', model: 'AppleTV3,2' } }],
        [type, { name: 'aa:bb:cc:dd:ee:ff', host: 'other.local', addresses: ['192.0.2.99'], port: 3689 }],
      ];
      for (const [serviceType, record] of dmapFirst ? records.reverse() : records) callbacks.get(serviceType)!(record);
      await vi.advanceTimersByTimeAsync(10);
      const devices = await pending;
      expect(devices).toHaveLength(2);
      const tv = devices.find(device => device.deviceId === 'AA:BB:CC:DD:EE:FF')!;
      expect(tv.dmapPort).toBeUndefined();
      expect(tv.identifiers).toEqual(['AA:BB:CC:DD:EE:FF']);
      expect(devices.find(device => device.dmapPort)?.deviceId).toBe('dmap:aa:bb:cc:dd:ee:ff');
    });

    it(`does not join ${type} by hostname alone (DMAP first: ${dmapFirst})`, async () => {
      const pending = scan({ timeout: 10 });
      const records: [string, object][] = [
        ['airplay', { name: 'TV', host: 'tv.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac' } }],
        [type, { name: 'legacy-id', host: 'TV.LOCAL', addresses: ['fd00::99'], port: 3689 }],
      ];
      for (const [serviceType, record] of dmapFirst ? records.reverse() : records) callbacks.get(serviceType)!(record);
      await vi.advanceTimersByTimeAsync(10);
      const devices = await pending;
      expect(devices).toHaveLength(2);
      expect(devices.find(device => device.deviceId === 'mac')?.dmapAddress).toBeUndefined();
    });

    it(`selects the shared ${type} endpoint instead of an unrelated first address (DMAP first: ${dmapFirst})`, async () => {
      const pending = scan({ timeout: 10 });
      const records: [string, object][] = [
        ['airplay', { name: 'TV', addresses: ['fd00::30'], port: 7000, txt: { deviceid: 'mac' } }],
        [type, { name: 'legacy-id', addresses: ['192.0.2.99', 'fd00::30'], port: 3689 }],
      ];
      for (const [serviceType, record] of dmapFirst ? records.reverse() : records) callbacks.get(serviceType)!(record);
      await vi.advanceTimersByTimeAsync(10);
      const devices = await pending;
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ deviceId: 'mac', address: 'fd00::30', dmapAddress: 'fd00::30', dmapPort: 3689 });
    });
  }
}

it.each(['companion-link', 'mediaremotetv'])('does not match unrelated %s IDs to AirPlay device IDs', async type => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'TV', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'copied-id' } });
  callbacks.get(type)!({ name: 'Other', addresses: ['192.0.2.99'], port: 49152, txt: { rpmrtid: 'copied-id', uniqueidentifier: 'copied-id' } });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toHaveLength(2);
});

for (const mrpFirst of [false, true]) {
  it(`retains a known MAC identity across disjoint service endpoints (MRP first: ${mrpFirst})`, async () => {
    const pending = scan({ timeout: 10 });
    const records: [string, object][] = [
      ['airplay', { name: 'TV', host: 'ipv4.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'AA:BB:CC:DD:EE:FF' } }],
      ['mediaremotetv', { name: 'TV', host: 'ipv6.local', addresses: ['fd00::30'], port: 49152, txt: { macaddress: 'aa:bb:cc:dd:ee:ff', uniqueidentifier: 'mrp-id' } }],
    ];
    for (const [type, record] of mrpFirst ? records.reverse() : records) callbacks.get(type)!(record);
    await vi.advanceTimersByTimeAsync(10);
    const devices = await pending;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ deviceId: 'AA:BB:CC:DD:EE:FF', mrpAddress: 'fd00::30', mrpPort: 49152 });
  });
}

it('joins MRP and Companion by their shared MRP identifier, preserving endpoints', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('companion-link')!({ name: 'TV', host: 'companion.local', addresses: ['fd00::30'], port: 49153, txt: { rpmrtid: 'MRP-ID' } });
  callbacks.get('mediaremotetv')!({ name: 'TV', host: 'mrp.local', addresses: ['192.0.2.30'], port: 49152, txt: { uniqueidentifier: 'mrp-id' } });
  await vi.advanceTimersByTimeAsync(10);
  const devices = await pending;
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({ deviceId: 'mrp-id', companionAddress: 'fd00::30', mrpAddress: '192.0.2.30' });
});

for (const reverse of [false, true]) {
  it(`retains same-identity AirPlay multihoming for DMAP overlap (reversed: ${reverse})`, async () => {
    const pending = scan({ timeout: 10 });
    const records: [string, object][] = [
      ['airplay', { name: 'TV', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac' } }],
      ['airplay', { name: 'TV', addresses: ['fd00::30'], port: 7000, txt: { deviceid: 'MAC' } }],
      ['touch-able', { name: 'legacy-id', addresses: ['192.0.2.99', 'fd00::30'], port: 3689 }],
    ];
    for (const [type, record] of reverse ? records.reverse() : records) callbacks.get(type)!(record);
    await vi.advanceTimersByTimeAsync(10);
    const devices = await pending;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ address: '192.0.2.30', dmapAddress: 'fd00::30' });
  });
}

it('retains compatible modern identity joins through MRP without requiring shared addresses', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('companion-link')!({ name: 'TV', host: 'companion.local', addresses: ['fd00::30'], port: 49153, txt: { rpmrtid: 'mrp-id' } });
  callbacks.get('airplay')!({ name: 'TV', host: 'airplay.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac' } });
  callbacks.get('mediaremotetv')!({ name: 'TV', host: 'mrp.local', addresses: ['192.0.2.31'], port: 49152, txt: { macaddress: 'mac', uniqueidentifier: 'mrp-id' } });
  await vi.advanceTimersByTimeAsync(10);
  const devices = await pending;
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({ deviceId: 'mac', companionAddress: 'fd00::30', mrpAddress: '192.0.2.31' });
});

it('prefers shared endpoints for modern services joined by address overlap', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'TV', addresses: ['fd00::30'], port: 7000, txt: { deviceid: 'mac' } });
  callbacks.get('companion-link')!({ name: 'TV', addresses: ['192.0.2.99', 'fd00::30'], port: 49153 });
  callbacks.get('mediaremotetv')!({ name: 'TV', addresses: ['192.0.2.98', 'fd00::30'], port: 49152 });
  await vi.advanceTimersByTimeAsync(10);
  const devices = await pending;
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({ companionAddress: 'fd00::30', mrpAddress: 'fd00::30' });
});

it('does not inherit DMAP association through a different modern service endpoint', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'TV', host: 'tv.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac' } });
  callbacks.get('companion-link')!({ name: 'TV', host: 'tv.local', addresses: ['fd00::30'], port: 49153, txt: { rpmrtid: 'mrp-id' } });
  callbacks.get('touch-able')!({ name: 'Other', host: 'other.local', addresses: ['fd00::30'], port: 3689 });
  await vi.advanceTimersByTimeAsync(10);
  const devices = await pending;
  expect(devices).toHaveLength(2);
  expect(devices.find(device => device.deviceId === 'mac')?.dmapPort).toBeUndefined();
});

for (const foreignHost of ['a-other.local', 'z-other.local']) {
  for (const reverse of [false, true]) {
    it(`keeps a copied AirPlay ID at ${foreignHost} separate (reversed: ${reverse})`, async () => {
      const pending = scan({ timeout: 10 });
      const records: [string, object][] = [
        ['airplay', { name: 'TV', host: 'tv.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac' } }],
        ['airplay', { name: 'Other', host: foreignHost, addresses: ['192.0.2.99'], port: 7000, txt: { deviceid: 'mac' } }],
        ['touch-able', { name: 'legacy-id', host: foreignHost, addresses: ['192.0.2.99'], port: 3689 }],
      ];
      for (const [type, record] of reverse ? records.reverse() : records) callbacks.get(type)!(record);
      await vi.advanceTimersByTimeAsync(10);
      const devices = await pending;
      expect(devices).toHaveLength(2);
      expect(devices.find(device => device.address === '192.0.2.30'))
        .toMatchObject({ deviceId: 'mac', dmapPort: undefined, dmapAddress: undefined });
      expect(devices.find(device => device.address === '192.0.2.99'))
        .toMatchObject({ deviceId: 'mac', dmapPort: 3689, dmapAddress: '192.0.2.99' });
    });
  }
}

it('retains multihomed advertisements sharing the same AirPlay ID and hostname', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('airplay')!({ name: 'TV', host: 'TV.LOCAL', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac' } });
  callbacks.get('airplay')!({ name: 'TV', host: 'tv.local', addresses: ['fd00::30'], port: 7000, txt: { deviceid: 'MAC' } });
  callbacks.get('touch-able')!({ name: 'legacy-id', host: 'tv.local', addresses: ['fd00::30'], port: 3689 });
  await vi.advanceTimersByTimeAsync(10);
  const devices = await pending;
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({ address: '192.0.2.30', dmapAddress: 'fd00::30' });
});
