/**
 * The CLI's one-time import of pre-0.5 ~/.atv-*.json files into ~/.atv-storage.json, run against
 * the real filesystem. Each test gets its own temporary HOME and a fresh CLI module, since the
 * CLI resolves its file paths and caches the store at import.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { Credentials } from '../credentials.js';

vi.mock('../discovery.js', () => ({ scan: async () => [] }));

type Stored = { devices: { key: string; credentials?: Record<string, { clientId?: string; guid?: string }>; hints?: Record<string, unknown> }[] };

const hap = (id: string) => ({ clientId: id, clientLTSK: Buffer.alloc(32, 1), clientLTPK: Buffer.alloc(32, 2), serverLTPK: Buffer.alloc(32, 3), serverId: `${id}-server` });
const write = (name: string, value: unknown) => writeFileSync(join(process.env.HOME!, name), JSON.stringify(value));
const stored = () => JSON.parse(readFileSync(join(process.env.HOME!, '.atv-storage.json'), 'utf8')) as Stored;
/** clientId per credential kind, per device key. */
const kinds = () => Object.fromEntries(stored().devices.map(d => [d.key, Object.fromEntries(Object.entries(d.credentials ?? {}).map(([k, v]) => [k, v.clientId ?? v.guid]))]));

/** Run one CLI command that loads storage, then fails harmlessly on an unknown selector. */
async function runCli(): Promise<void> {
  vi.resetModules();
  const { main } = await import('../cli/index.js');
  await main(['power', 'no-such-device']).catch(() => {});
}

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'atv-import-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

it('imports released `atv pair` credentials as AirPlay and MRP-only devices as MRP, keeping Companion', async () => {
  write('.atv-credentials.json', {
    // Every released `atv pair` (0.2.0–0.4.0) used AirPlay pair-setup.
    'AA:AA': new Credentials(hap('airplay'), hap('companion')).serialize(),
    // Unreleased main paired over standalone MRP when a device had no AirPlay port.
    'BB:BB': new Credentials(hap('mrp')).serialize(),
    // No cached hints at all.
    'old-alias': new Credentials(hap('alias')).serialize(),
  });
  write('.atv-devices.json', {
    'AA:AA': { address: '192.0.2.1', port: 7000, companionPort: 49153 },
    'BB:BB': { mrpAddress: '192.0.2.2', mrpPort: 49152 },
  });
  await runCli();
  expect(kinds()).toEqual({
    'AA:AA': { airplay: 'airplay', companion: 'companion' },
    'BB:BB': { mrp: 'mrp' },
    'old-alias': { airplay: 'alias' },
  });
});

it('imports a Companion-only pairing (outer key equal to the Companion key) as Companion only', async () => {
  // 0.4.0 `atv companion-pair` without a prior `atv pair` saved Credentials(companion, companion).
  write('.atv-credentials.json', { 'CC:CC': new Credentials(hap('companion'), hap('companion')).serialize() });
  await runCli();
  expect(kinds()).toEqual({ 'CC:CC': { companion: 'companion' } });
});

it('imports legacy DMAP GUIDs and device hints alongside HAP credentials', async () => {
  write('.atv-credentials.json', { 'AA:AA': new Credentials(hap('airplay')).serialize() });
  write('.atv-dmap.json', { 'dmap-tv': '0x0123456789ABCDEF' });
  write('.atv-devices.json', { 'AA:AA': { address: '192.0.2.1', port: 7000 } });
  await runCli();
  expect(kinds()).toEqual({ 'AA:AA': { airplay: 'airplay' }, 'dmap-tv': { dmap: '0x0123456789ABCDEF' } });
  expect(stored().devices.find(d => d.key === 'AA:AA')?.hints).toEqual({ address: '192.0.2.1', port: 7000 });
});

it('imports once: later changes to the legacy files are not re-imported', async () => {
  write('.atv-credentials.json', { 'AA:AA': new Credentials(hap('airplay')).serialize() });
  await runCli();
  const first = readFileSync(join(process.env.HOME!, '.atv-storage.json'), 'utf8');
  write('.atv-credentials.json', { 'AA:AA': new Credentials(hap('airplay')).serialize(), 'DD:DD': new Credentials(hap('late')).serialize() });
  await runCli();
  expect(readFileSync(join(process.env.HOME!, '.atv-storage.json'), 'utf8')).toBe(first);
});
