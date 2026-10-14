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

it('merges DMAP with AirPlay while retaining distinct service endpoints', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('touch-able')!({ name: 'legacy-id', host: 'tv.local', addresses: ['fd00::30'], port: 3689, txt: { CtlN: 'Living Room' } });
  callbacks.get('airplay')!({ name: 'Living Room', host: 'tv.local', addresses: ['192.0.2.30'], port: 7000, txt: { deviceid: 'mac', model: 'AppleTV3,2' } });
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject([{ deviceId: 'mac', address: '192.0.2.30', port: 7000, dmapPort: 3689, dmapAddress: 'fd00::30', identifiers: ['mac', 'legacy-id'] }]);
});
it('does not expose DMAP Home Sharing credentials as device identifiers', async () => {
  const pending = scan({ timeout: 10 });
  callbacks.get('appletv-v2')!({ name: 'legacy-id', addresses: ['192.0.2.40'], port: 3689, txt: { Name: 'TV', hGID: 'private-home-sharing-id' } });
  await vi.advanceTimersByTimeAsync(10);
  expect((await pending)[0].identifiers).toEqual(['legacy-id']);
});
