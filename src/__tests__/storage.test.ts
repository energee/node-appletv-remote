import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CustomStorage, FileStorage, MemoryStorage, type DeviceRecord, type StorageAdapter, type StorageDocument } from '../storage.js';

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

  it('round-trips all credential carriers and removes empty credential/settings containers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atv-storage-carriers-'));
    const path = join(directory, 'store.json');
    try {
      const first = new FileStorage(path);
      await first.load();
      first.upsert({
        key: 'TV',
        aliases: ['tv-alias'],
        credentials: {
          airplay: { clientId: 'airplay', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server-airplay' },
          mrp: { clientId: 'mrp', clientLTSK: 'd'.repeat(64), clientLTPK: 'e'.repeat(64), serverLTPK: 'f'.repeat(64), serverId: 'server-mrp' },
          companion: { clientId: 'companion', clientLTSK: '1'.repeat(64), clientLTPK: '2'.repeat(64), serverLTPK: '3'.repeat(64), serverId: 'server-companion' },
          raop: { clientId: '0123456789ABCDEF', seed: '4'.repeat(64) },
          dmap: { guid: '0x0123456789ABCDEF' },
        },
        settings: { dmap: { controllerName: 'Controller' } },
      });
      await first.save();
      const second = new FileStorage(path);
      await second.load();
      expect(second.hap('TV-ALIAS', 'mrp')?.serverId).toBe('server-mrp');
      expect(second.resolveConnection('tv', 'companion').credentials?.serverId).toBe('server-companion');
      expect(second.resolveConnection('tv', 'raop').raop).toEqual({ clientId: '0123456789ABCDEF', seed: Buffer.from('4'.repeat(64), 'hex') });
      expect(second.resolveConnection('tv', 'dmap').dmapGuid).toBe('0x0123456789ABCDEF');
      expect(second.removeCredential('tv', 'airplay')).toBe(true);
      expect(second.removeCredential('tv', 'mrp')).toBe(true);
      expect(second.removeCredential('tv', 'companion')).toBe(true);
      expect(second.removeCredential('tv', 'raop')).toBe(true);
      expect(second.removeCredential('tv', 'dmap')).toBe(true);
      expect(second.removeSettings('tv', 'dmap')).toBe(true);
      expect(second.get('tv')).not.toHaveProperty('credentials');
      expect(second.get('tv')).not.toHaveProperty('settings');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('shares validation, dirty tracking, and forward-field preservation with custom adapters', async () => {
    let saved: StorageDocument | undefined;
    const adapter: StorageAdapter = {
      load: async () => ({
        version: 1,
        futureDocumentField: { preserved: true },
        devices: [{
          key: 'TV',
          aliases: ['tv-alias'],
          futureRecordField: 'preserved',
          credentials: { airplay: { clientId: 'client', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server' }, futureCredentialField: 'preserved' },
          hints: { address: '192.0.2.1', futureHintField: 'preserved' },
        }],
      } as unknown as StorageDocument),
      save: async document => { saved = document; },
    };
    const store = new CustomStorage(adapter);
    await store.load();
    expect(store.dirty).toBe(false);
    store.upsert({ key: 'tv', aliases: ['tv-alias'], settings: { airplay: { settleMs: 50 } } });
    await store.save();
    expect(store.dirty).toBe(false);
    expect(saved as unknown).toMatchObject({
      futureDocumentField: { preserved: true },
      devices: [{ futureRecordField: 'preserved', credentials: { futureCredentialField: 'preserved' }, hints: { futureHintField: 'preserved' } }],
    });
  });

  it('loads repeated aliases belonging to the same record without creating ambiguity', async () => {
    const existing = new MemoryStorage({ version: 1, devices: [{
      key: 'tv', aliases: ['TV', 'tv'], credentials: { dmap: { guid: '0x0123456789ABCDEF' } },
    }] });
    await existing.load();
    expect(existing.resolveConnection('TV', 'dmap').dmapGuid).toBe('0x0123456789ABCDEF');
  });

  it('rejects unsupported future versions', async () => {
    const future = new MemoryStorage({ version: 2, devices: [] } as unknown as StorageDocument);
    await expect(future.load()).rejects.toThrow('Unsupported storage document version');
  });

  it.each([
    ['a falsy credentials container', { credentials: false }, 'credentials must be an object'],
    ['a falsy HAP credential', { credentials: { airplay: null } }, 'airplay must be an object'],
    ['a falsy settings container', { settings: false }, 'settings must be an object'],
    ['an array protocol setting', { settings: { airplay: [] } }, 'settings must be protocol objects'],
    ['an array hints container', { hints: [] }, 'hints must be an object'],
  ])('rejects %s on load and upsert', async (_name, fields, message) => {
    const document = { version: 1, devices: [{ key: 'tv', aliases: [], ...fields }] } as unknown as StorageDocument;
    await expect(new MemoryStorage(document).load()).rejects.toThrow(message);

    const store = new MemoryStorage();
    await store.load();
    expect(() => store.upsert({ key: 'tv', aliases: [], ...fields } as unknown as DeviceRecord)).toThrow(message);
  });

  it.each(['null', 'false', '0', '""'])('rejects a %s document without permitting an empty-store overwrite', async json => {
    const directory = await mkdtemp(join(tmpdir(), 'atv-corrupt-store-'));
    const path = join(directory, 'store.json');
    try {
      await writeFile(path, json);
      const store = new FileStorage(path);
      await expect(store.load()).rejects.toThrow('Invalid storage document');
      expect(() => store.setHap('tv', 'airplay', hap('c'))).toThrow('Storage must be loaded before use');
      await expect(store.save()).rejects.toThrow('Storage must be loaded before use');
      expect(await readFile(path, 'utf8')).toBe(json);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains the previous loaded credentials and dirty state after an invalid reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atv-reload-store-'));
    const path = join(directory, 'store.json');
    try {
      const store = new FileStorage(path);
      await store.load();
      store.setHap('tv', 'airplay', hap('c'));
      await writeFile(path, 'null');
      await expect(store.load()).rejects.toThrow('Invalid storage document');
      expect(store.hap('tv', 'airplay')?.serverId).toBe('server-c');
      expect(store.dirty).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects corrupt JSON and reloads restored credentials', async () => {
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
  it('loads a DMAP-only endpoint whose absent AirPlay port is zero', async () => {
    const store = new MemoryStorage({ version: 1, devices: [{ key: 'dmap:tv', aliases: ['dmap:tv'], hints: { address: '192.0.2.10', port: 0, dmapPort: 3689 } }] });
    await store.load();
    expect(store.resolveConnection('dmap:tv', 'dmap').endpoint).toMatchObject({ port: 0, dmapPort: 3689 });
  });
});
