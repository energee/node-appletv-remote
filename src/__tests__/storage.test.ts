import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStorage, MemoryStorage } from '../storage.js';

const hap = (byte: string) => ({ clientId: `client-${byte}`, clientLTSK: Buffer.from(byte.repeat(64), 'hex'), clientLTPK: Buffer.from(byte.repeat(64), 'hex'), serverLTPK: Buffer.from(byte.repeat(64), 'hex'), serverId: `server-${byte}` });

describe('storage', () => {
  it('keeps protocol credentials separate and tracks explicit saves', async () => {
    const store = new MemoryStorage();
    await store.load();
    store.setHap('living-room', 'airplay', hap('a'), ['living-room', 'AA:BB']);
    store.setHap('living-room', 'companion', hap('b'), ['living-room', 'AA:BB']);
    expect(store.dirty).toBe(true);
    await store.save();
    expect(store.dirty).toBe(false);
    expect(store.hap('AA:BB', 'airplay')?.clientId).toBe('client-a');
    expect(store.hap('living-room', 'companion')?.clientId).toBe('client-b');
    expect(() => store.upsert({ key: 'other', aliases: ['aa:bb'] })).toThrow('collision');
    expect(store.remove('living-room')).toBe(true);
  });

  it('preserves a readable document when replacement fails and rejects corrupt input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atv-store-'));
    const path = join(directory, 'store.json');
    const first = new FileStorage(path);
    await first.load();
    first.setHap('tv', 'airplay', hap('c'));
    await first.save();
    const original = await readFile(path, 'utf8');
    await writeFile(path, '{not json');
    const corrupt = new FileStorage(path);
    await expect(corrupt.load()).rejects.toThrow();
    await writeFile(path, original);
    const second = new FileStorage(path);
    await second.load();
    expect(second.hap('tv', 'airplay')?.serverId).toBe('server-c');
  });
});
