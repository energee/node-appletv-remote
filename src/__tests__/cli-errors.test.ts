/** The CLI observes asynchronous AirPlay failures before and after setup. */
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ tv: undefined as EventEmitter | undefined }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: () => true, readFileSync: () => JSON.stringify({ test: '{}' }), writeFileSync: vi.fn() }));
vi.mock('../credentials.js', () => ({ Credentials: { deserialize: () => ({ companionCredentials: {} }) } }));
vi.mock('../cli/device-cache.js', () => ({ withCachedDevice: async (_path: string, _id: string, _scan: unknown, connect: (device: unknown) => Promise<unknown>) => connect({ name: 'offline', address: 'offline', port: 7000, companionPort: 1234 }) }));
vi.mock('../appletv.js', () => ({
  Key: { Up: 'up' }, ShuffleState: {}, RepeatState: {}, contentItems: () => [], INPUT_ACTIONS: ['singleTap', 'doubleTap', 'hold'],
  AppleTV: class extends EventEmitter {
    constructor() { super(); state.tv = this; }
    async connect() { this.emit('error', new Error('setup transport failure')); }
    async connectCompanion() { this.emit('companionError', new Error('setup transport failure')); }
    async close() {}
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
  expect(state.tv).toBeDefined();
  expect(() => state.tv!.emit('error', new Error('late transport failure'))).not.toThrow();
  expect(errors.mock.calls.flat().join(' ')).toContain('setup transport failure');
  expect(errors.mock.calls.flat().join(' ')).toContain('late transport failure');
});
