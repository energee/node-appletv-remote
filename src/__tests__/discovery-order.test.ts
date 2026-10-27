/** Tests that scan() pairs AirPlay and Companion mDNS records regardless of arrival or address order. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scan } from '../discovery.js';

const mock = vi.hoisted(() => ({ callbacks: new Map<string, (service: Record<string, unknown>) => void>(), stopped: vi.fn(), updated: vi.fn(), destroyed: vi.fn() }));
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    find(options: { type: string }, callback: (service: Record<string, unknown>) => void) {
      mock.callbacks.set(options.type, callback);
      return { stop: mock.stopped, update: mock.updated };
    }
    destroy() { mock.destroyed(); }
  },
}));

beforeEach(() => { vi.useFakeTimers(); mock.callbacks.clear(); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe('mDNS service ordering', () => {
  for (const order of [['airplay', 'companion-link'], ['companion-link', 'airplay']]) {
    it(`finds the Companion port when ${order[0]} arrives first`, async () => {
      const services: Record<string, Record<string, unknown>> = {
        airplay: { name: 'Synthetic TV', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'synthetic-tv', model: 'AppleTV6,2' } },
        'companion-link': { addresses: ['192.0.2.10'], port: 49153 },
      };
      const pending = scan({ timeout: 10 });
      for (const service of order) mock.callbacks.get(service)!(services[service]);
      await vi.advanceTimersByTimeAsync(10);
      const devices = await pending;
      expect(devices).toHaveLength(1);
      expect(devices[0].companionPort).toBe(services['companion-link'].port);
      expect(mock.stopped).toHaveBeenCalledTimes(6);
      expect(mock.destroyed).toHaveBeenCalledOnce();
    });
  }

  it('finds the Companion port when a multihomed TV lists its addresses in a different order', async () => {
    const pending = scan({ timeout: 10 });
    mock.callbacks.get('airplay')!({
      name: 'Synthetic TV', host: 'synthetic-tv.local', addresses: ['192.0.2.10', '192.0.2.11'], port: 7000,
      txt: { deviceid: 'synthetic-tv', model: 'AppleTV6,2' },
    });
    mock.callbacks.get('companion-link')!({
      host: 'synthetic-tv.local', addresses: ['192.0.2.11', '192.0.2.10'], port: 49153,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending)[0].companionPort).toBe(49153);
  });
});

describe('conflicting primary identities', () => {
  const orders = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  for (const type of ['touch-able', 'appletv-v2', 'companion-link', 'mediaremotetv', 'airplay']) {
    for (const order of orders) {
      it(`keeps two TVs separate from a bridging ${type} record in order ${order}`, async () => {
        const pending = scan({ timeout: 10 });
        const records: [string, Record<string, unknown>][] = [
          ['airplay', { name: 'TV A', host: 'a.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'tv-a' } }],
          ['airplay', { name: 'TV B', host: 'b.local', addresses: ['192.0.2.20'], port: 7000, txt: { deviceid: 'tv-b' } }],
          [type, { name: 'Ambiguous service', addresses: ['192.0.2.99', '192.0.2.10', '192.0.2.20'], port: 3689 }],
        ];
        for (const index of order) {
          const [serviceType, record] = records[index];
          mock.callbacks.get(serviceType)!(record);
        }
        await vi.advanceTimersByTimeAsync(10);
        const devices = await pending;
        expect(devices).toHaveLength(3);
        const tvs = devices.filter(device => ['tv-a', 'tv-b'].includes(device.deviceId));
        expect(tvs).toHaveLength(2);
        for (const tv of tvs) {
          expect(tv.dmapPort).toBeUndefined();
          expect(tv.mrpPort).toBeUndefined();
          expect(tv.companionPort).toBeUndefined();
        }
        expect(devices.find(device => device.address === '192.0.2.99')?.port).toBe(type === 'airplay' ? 3689 : 0);
      });
    }
  }

  for (const reverse of [false, true]) {
    it(`keeps conflicting AirPlay IDs separate despite the same host/address (reversed: ${reverse})`, async () => {
      const pending = scan({ timeout: 10 });
      const records = [
        { name: 'TV A', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'tv-a' } },
        { name: 'TV B', host: 'tv.local', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'tv-b' } },
      ];
      for (const record of reverse ? records.reverse() : records) mock.callbacks.get('airplay')!(record);
      await vi.advanceTimersByTimeAsync(10);
      expect((await pending).map(device => device.deviceId).sort()).toEqual(['tv-a', 'tv-b']);
    });
  }

  it('can stop early on the shared DMAP endpoint, not the unrelated first address', async () => {
    const pending = scan({ timeout: 5000, until: device => device.deviceId === 'tv-a' && !!device.dmapPort });
    mock.callbacks.get('touch-able')!({ name: 'legacy', addresses: ['192.0.2.99', 'fd00::10'], port: 3689 });
    mock.callbacks.get('airplay')!({ name: 'TV A', addresses: ['fd00::10'], port: 7000, txt: { deviceid: 'tv-a' } });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending)[0]).toMatchObject({ deviceId: 'tv-a', dmapAddress: 'fd00::10' });
  });
});

describe('scan until', () => {
  const tv = { name: 'Synthetic TV', addresses: ['192.0.2.10'], port: 7000, txt: { deviceid: 'synthetic-tv', model: 'AppleTV6,2' } };

  it('resolves as soon as a device matches, without waiting for the timeout', async () => {
    const pending = scan({ timeout: 5000, until: (d) => d.deviceId === 'synthetic-tv' });
    mock.callbacks.get('airplay')!(tv);
    await vi.advanceTimersByTimeAsync(0);
    const devices = await pending;
    expect(devices.map((d) => d.deviceId)).toEqual(['synthetic-tv']);
    expect(mock.destroyed).toHaveBeenCalledOnce();
  });

  it('checks the condition after the Companion join, so it can wait for the Companion port', async () => {
    let settled = false;
    const pending = scan({ timeout: 5000, until: (d) => !!d.companionPort }).then((r) => { settled = true; return r; });
    mock.callbacks.get('airplay')!(tv);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    mock.callbacks.get('companion-link')!({ addresses: ['192.0.2.10'], port: 49153 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await pending)[0].companionPort).toBe(49153);
  });

  it('coalesces a burst of records into one until() evaluation pass', async () => {
    const until = vi.fn(() => false);
    const pending = scan({ timeout: 10, until });
    for (let i = 0; i < 20; i++) mock.callbacks.get('airplay')!({ name: `TV ${i}`, addresses: [`192.0.2.${i + 1}`], port: 7000, txt: { deviceid: `tv-${i}` } });
    await vi.advanceTimersByTimeAsync(0);
    // One pass over 20 devices, not 1 + 2 + ... + 20 = 210 calls.
    expect(until).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(10); await pending;
  });

  it('falls back to the timeout when nothing matches', async () => {
    const pending = scan({ timeout: 10, until: () => false });
    mock.callbacks.get('airplay')!(tv);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toHaveLength(1);
    expect(mock.destroyed).toHaveBeenCalledOnce();
  });
});

// Hardware: one lost multicast reply hid a TV for a whole 5 s scan in about 1 of 30 sightings.
it('re-sends each browser query at 1 s and 3 s, and stops re-sending once the scan ends', async () => {
  const pending = scan({ timeout: 5000 });
  await vi.advanceTimersByTimeAsync(999);
  expect(mock.updated).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(mock.updated).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(2000);
  expect(mock.updated).toHaveBeenCalledTimes(12);
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  mock.updated.mockClear();
  const early = scan({ timeout: 5000, until: () => true });
  mock.callbacks.get('airplay')!({ name: 'TV', addresses: ['192.0.2.1'], port: 7000, txt: {} });
  await early;
  await vi.advanceTimersByTimeAsync(5000);
  expect(mock.updated).not.toHaveBeenCalled();
});

it.each(['filter', 'until'] as const)('rejects throwing scan %s callbacks and cleans Bonjour', async option => {
  const pending = scan({ timeout: 5000, until: () => false, [option]: () => { throw new Error('callback failed'); } });
  const assertion = expect(pending).rejects.toThrow('callback failed');
  expect(() => mock.callbacks.get('airplay')!({ name: 'TV', addresses: ['192.0.2.1'], port: 7000, txt: {} })).not.toThrow();
  await assertion;
  expect(mock.stopped).toHaveBeenCalledTimes(6); expect(mock.destroyed).toHaveBeenCalledOnce();
});
