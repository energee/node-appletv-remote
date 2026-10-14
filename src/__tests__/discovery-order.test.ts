/** Tests that scan() pairs AirPlay and Companion mDNS records regardless of arrival or address order. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scan } from '../discovery.js';

const mock = vi.hoisted(() => ({ callbacks: new Map<string, (service: Record<string, unknown>) => void>(), stopped: vi.fn(), destroyed: vi.fn() }));
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    find(options: { type: string }, callback: (service: Record<string, unknown>) => void) {
      mock.callbacks.set(options.type, callback);
      return { stop: mock.stopped };
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
      expect(mock.stopped).toHaveBeenCalledTimes(5);
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

  it('falls back to the timeout when nothing matches', async () => {
    const pending = scan({ timeout: 10, until: () => false });
    mock.callbacks.get('airplay')!(tv);
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toHaveLength(1);
    expect(mock.destroyed).toHaveBeenCalledOnce();
  });
});

it.each(['filter', 'until'] as const)('rejects throwing scan %s callbacks and cleans Bonjour', async option => {
  const pending = scan({ timeout: 5000, until: () => false, [option]: () => { throw new Error('callback failed'); } });
  const assertion = expect(pending).rejects.toThrow('callback failed');
  expect(() => mock.callbacks.get('airplay')!({ name: 'TV', addresses: ['192.0.2.1'], port: 7000, txt: {} })).not.toThrow();
  await assertion;
  expect(mock.stopped).toHaveBeenCalledTimes(5); expect(mock.destroyed).toHaveBeenCalledOnce();
});
