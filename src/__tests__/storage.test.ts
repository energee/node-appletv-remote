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
    store.upsert({ key: 'living-room', aliases: ['living-room', 'AA:BB'], settings: { airplay: { settleMs: 20, endpoint: { address: '192.0.2.1', port: 7000 } } } });
    expect(store.resolveConnection('living-room', 'airplay', { settleMs: 5, endpoint: { port: 7001 } })).toMatchObject({ settleMs: 5, endpoint: { address: '192.0.2.1', port: 7001 } });
    expect(store.removeCredential('living-room', 'airplay')).toBe(true);
    expect(store.hap('living-room', 'airplay')).toBeUndefined();
    expect(store.hap('living-room', 'companion')?.clientId).toBe('client-b');
    expect(store.removeSettings('living-room', 'airplay')).toBe(true);
    expect(() => store.upsert({ key: 'other', aliases: ['aa:bb'] })).toThrow('belongs to more than one');
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
