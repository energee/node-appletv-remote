/** The CLI observes asynchronous AirPlay failures before and after setup. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ tv: undefined as EventEmitter | undefined }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: () => true, readFileSync: () => JSON.stringify({ test: '{}' }), writeFileSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: async () => JSON.stringify({ version: 1, devices: [{ key: 'test', aliases: ['test'], credentials: { airplay: { clientId: 'client', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server' }, companion: { clientId: 'companion', clientLTSK: 'd'.repeat(64), clientLTPK: 'e'.repeat(64), serverLTPK: 'f'.repeat(64), serverId: 'server' } } }] }), mkdir: async () => {}, writeFile: async () => {}, chmod: async () => {}, rename: async () => {}, rm: async () => {} }));
vi.mock('../discovery.js', () => ({ scan: async () => [{ name: 'offline', deviceId: 'test', address: 'offline', port: 7000, companionPort: 1234, model: 'test' }] }));
vi.mock('../appletv.js', () => ({
  Key: { Up: 'up' }, ShuffleState: {}, RepeatState: {}, contentItems: () => [], INPUT_ACTIONS: ['singleTap', 'doubleTap', 'hold'],
  AppleTV: class extends EventEmitter {
    constructor() { super(); state.tv = this; }
    async connect() { this.emit('error', new Error('setup transport failure')); }
    async connectCompanion() { this.emit('companionError', new Error('setup transport failure')); }
    async close() {}
    featureAvailability() { return 'unknown'; }
    async sendKeyCommand() {}
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });
it('reports transport errors instead of throwing the special error event', async () => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'atv', 'command', 'up']);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { main } = await import('../cli/index.js');
  await main(['command', 'up']);
  expect(errors.mock.calls.flat().join(' ')).toContain('setup transport failure');
});
