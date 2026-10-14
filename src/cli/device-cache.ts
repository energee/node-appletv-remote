/**
 * CLI cache of each paired device's last-known address, so commands can skip the
 * mDNS scan. A stale entry (TV changed IP or port) falls back to a fresh scan.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { DiscoveredDeviceInfo } from '../discovery.js';

type Cache = Record<string, DiscoveredDeviceInfo>;

/** Read every cached entry; a missing or unreadable file is an empty cache. */
function readCache(file: string): Cache {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Run `connect` against the device cached under `id` in `file`. If there is none or
 * it fails, `rescan` and run `connect` once more, caching the fresh device on success.
 */
export async function withCachedDevice<T>(
  file: string,
  id: string,
  rescan: () => Promise<DiscoveredDeviceInfo>,
  connect: (device: DiscoveredDeviceInfo) => Promise<T>,
): Promise<T> {
  const cache = readCache(file);
  const cached = cache[id];
  if (cached) {
    try {
      return await connect(cached);
    } catch {
      // Stale address; fall through to a fresh scan.
    }
  }
  const device = await rescan();
  const result = await connect(device);
  cache[id] = device;
  writeFileSync(file, JSON.stringify(cache, null, 2));
  return result;
}
