/**
 * CLI cache of each paired device's last-known address, so commands can skip the
 * mDNS scan. A stale entry (TV changed IP or port) falls back to a fresh scan.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { DiscoveredDeviceInfo } from '../discovery.js';

/** Read every cached entry; a missing or unreadable file is an empty cache. */
function readAll(file: string): Record<string, DiscoveredDeviceInfo> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

/** Return the cached device for `id`, if any. */
export function loadCachedDevice(file: string, id: string): DiscoveredDeviceInfo | undefined {
  return readAll(file)[id];
}

/** Store `device` under `id`, keeping other entries. */
export function saveCachedDevice(file: string, id: string, device: DiscoveredDeviceInfo): void {
  const all = readAll(file);
  all[id] = { ...device };
  writeFileSync(file, JSON.stringify(all, null, 2));
}

/**
 * Run `connect` against the cached device; if there is none or it fails, `rescan`
 * and run `connect` once more on the fresh result.
 */
export async function withCachedDevice<T>(
  cached: DiscoveredDeviceInfo | undefined,
  rescan: () => Promise<DiscoveredDeviceInfo>,
  connect: (device: DiscoveredDeviceInfo) => Promise<T>,
): Promise<T> {
  if (cached) {
    try {
      return await connect(cached);
    } catch {
      // Stale address; fall through to a fresh scan.
    }
  }
  return connect(await rescan());
}
