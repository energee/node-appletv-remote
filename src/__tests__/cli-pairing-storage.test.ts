import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { FileStorage } from '../storage.js';

vi.mock('../discovery.js', () => ({ scan: vi.fn(async () => [{
  name: 'Test TV', deviceId: 'device', address: '127.0.0.1', port: 1, model: 'test',
}]) }));
vi.mock('node:readline', () => {
  const answers = ['1', '1234'];
  return { createInterface: () => ({
    question: (_question: string, reply: (value: string) => void) => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('Unexpected CLI prompt');
      reply(answer);
    },
    close() {},
  }) };
});

let home: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

it('keeps the previous on-disk identity intact when pairing rejects the PIN', async () => {
  home = await mkdtemp(join(tmpdir(), 'atv-pairing-storage-'));
  vi.stubEnv('HOME', home);
  const path = join(home, '.atv-storage.json');
  const store = new FileStorage(path);
  await store.load();
  const previous = {
    clientId: 'previous-client', clientLTSK: Buffer.alloc(32, 0xaa), clientLTPK: Buffer.alloc(32, 0xbb),
    serverLTPK: Buffer.alloc(32, 0xcc), serverId: 'previous-server',
  };
  store.setHap('device', 'airplay', previous);
  await store.save();
  const before = await readFile(path);
  const rejected = new Error('PIN rejected');
  vi.spyOn(AppleTV.prototype, 'startPairing').mockResolvedValue({
    finish: vi.fn().mockRejectedValue(rejected),
  } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // The CLI snapshots HOME at module load; initialize it only after installing the isolated HOME.
  const { main } = await import('../cli/index.js');
  await expect(main(['pair'])).rejects.toBe(rejected);
  expect(await readFile(path)).toEqual(before);
  const reloaded = new FileStorage(path);
  await reloaded.load();
  expect(reloaded.hap('device', 'airplay')).toEqual(previous);
});
