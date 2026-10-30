import { describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({
  files: new Map<string, string>(),
  fail: undefined as 'write' | 'chmod' | 'rename' | undefined,
  removed: [] as string[],
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  readFile: vi.fn(async (path: string) => {
    const value = filesystem.files.get(path);
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value;
  }),
  writeFile: vi.fn(async (path: string, data: string) => {
    if (filesystem.fail === 'write') throw Object.assign(new Error('write denied'), { code: 'EACCES' });
    filesystem.files.set(path, data);
  }),
  chmod: vi.fn(async () => {
    if (filesystem.fail === 'chmod') throw Object.assign(new Error('chmod denied'), { code: 'EACCES' });
  }),
  rename: vi.fn(async (from: string, to: string) => {
    if (filesystem.fail === 'rename') throw Object.assign(new Error('rename interrupted'), { code: 'EIO' });
    const value = filesystem.files.get(from);
    if (value === undefined) throw new Error('temporary file missing');
    filesystem.files.set(to, value);
    filesystem.files.delete(from);
  }),
  rm: vi.fn(async (path: string) => {
    filesystem.removed.push(path);
    filesystem.files.delete(path);
  }),
}));

import { FileStorage } from '../storage.js';

const destination = '/isolated/storage.json';
const hap = (byte: string) => ({ clientId: `client-${byte}`, clientLTSK: Buffer.from(byte.repeat(64), 'hex'), clientLTPK: Buffer.from(byte.repeat(64), 'hex'), serverLTPK: Buffer.from(byte.repeat(64), 'hex'), serverId: `server-${byte}` });

const failureMessages = {
  write: 'write denied',
  chmod: 'chmod denied',
  rename: 'rename interrupted',
};

describe('FileStorage replacement failures', () => {
  it.each(['write', 'chmod', 'rename'] as const)('keeps the original readable bytes and removes its temporary file after a %s failure', async failure => {
    filesystem.files.clear();
    filesystem.removed = [];
    filesystem.fail = undefined;
    const store = new FileStorage(destination);
    await store.load();
    store.setHap('tv', 'airplay', hap('a'));
    await store.save();
    const original = filesystem.files.get(destination)!;

    store.setHap('tv', 'companion', hap('b'));
    filesystem.fail = failure;
    await expect(store.save()).rejects.toThrow(failureMessages[failure]);

    expect(filesystem.files.get(destination)).toBe(original);
    expect([...filesystem.files.keys()]).toEqual([destination]);
    expect(filesystem.removed).toHaveLength(1);
    expect(filesystem.removed[0]).toMatch(/^\/isolated\/\.storage\.json\.[0-9a-f]{16}\.tmp$/);
    expect(store.dirty).toBe(true);
  });
});
