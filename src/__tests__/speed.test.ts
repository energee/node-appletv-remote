/** Tests for connect-speed changes: socket options/timeout and the CLI's cached-address fallback. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, Socket, type AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSocket } from '../connection.js';
import { loadCachedDevice, saveCachedDevice, withCachedDevice } from '../cli/device-cache.js';
import type { DiscoveredDeviceInfo } from '../discovery.js';

afterEach(() => vi.restoreAllMocks());

describe('connectSocket', () => {
  it('disables Nagle so small MRP writes are sent immediately', async () => {
    const server = createServer((s) => s.destroy()).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const spy = vi.spyOn(Socket.prototype, 'setNoDelay');
    const sock = await connectSocket('127.0.0.1', (server.address() as AddressInfo).port);
    expect(spy).toHaveBeenCalledWith(true);
    sock.destroy();
    server.close();
  });

  it('rejects instead of hanging when the host does not answer', async () => {
    // 192.0.2.0/24 is TEST-NET-1: never routed, so the SYN goes unanswered (or fails fast).
    await expect(connectSocket('192.0.2.1', 7000, 50)).rejects.toThrow();
  });
});

const device: DiscoveredDeviceInfo = { name: 'TV', address: '192.0.2.10', port: 7000, deviceId: 'aa:bb', model: 'AppleTV6,2' };

describe('device cache', () => {
  it('round-trips a device by ID through the cache file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'atv-')), 'devices.json');
    expect(loadCachedDevice(file, 'aa:bb')).toBeUndefined();
    saveCachedDevice(file, 'aa:bb', device);
    expect(loadCachedDevice(file, 'aa:bb')).toEqual(device);
  });

  it('connects to the cached device without scanning', async () => {
    const rescan = vi.fn();
    const result = await withCachedDevice(device, rescan, async (d) => d.address);
    expect(result).toBe('192.0.2.10');
    expect(rescan).not.toHaveBeenCalled();
  });

  it('rescans and retries once when the cached address fails', async () => {
    const moved = { ...device, address: '192.0.2.20' };
    const connect = vi.fn(async (d: DiscoveredDeviceInfo) => {
      if (d.address === device.address) throw new Error('ECONNREFUSED');
      return d.address;
    });
    expect(await withCachedDevice(device, async () => moved, connect)).toBe('192.0.2.20');
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('scans when nothing is cached', async () => {
    expect(await withCachedDevice(undefined, async () => device, async (d) => d.port)).toBe(7000);
  });
});
