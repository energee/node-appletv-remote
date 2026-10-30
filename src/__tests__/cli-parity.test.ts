/** CLI validation and failure boundaries for action modes, touch, output routing, DMAP and RAOP. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { DmapClient } from '../dmap/client.js';
import { DmapPairing } from '../dmap/pairing.js';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';
import { Readable } from 'node:stream';

const raop = vi.hoisted(() => ({ services: [] as object[], created: [] as unknown[][], stream: vi.fn() }));
const raopInput = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: vi.fn(() => true), readFileSync: vi.fn((path: string) => path.endsWith('.atv-dmap.json') ? '{"device":"0x0123456789ABCDEF"}' : '{"device":"modern-credentials"}'), writeFileSync: vi.fn(), createReadStream: vi.fn(() => Readable.from([])) }));
vi.mock('node:fs/promises', () => ({ readFile: async () => JSON.stringify({ version: 1, devices: [{ key: 'device', aliases: ['device'], credentials: { airplay: { clientId: 'client', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server' }, companion: { clientId: 'companion', clientLTSK: 'd'.repeat(64), clientLTPK: 'e'.repeat(64), serverLTPK: 'f'.repeat(64), serverId: 'server' }, dmap: { guid: '0x0123456789ABCDEF' } } }] }), mkdir: async () => {}, writeFile: async () => {}, chmod: async () => {}, rename: async () => {}, rm: async () => {} }));
vi.mock('node:readline', () => ({ createInterface: () => ({ question: (_q: string, answer: (value: string) => void) => answer('1'), close() {} }) }));
vi.mock('../discovery.js', async importOriginal => ({ ...(await importOriginal<typeof import('../discovery.js')>()), scan: vi.fn() }));
vi.mock('bonjour-service', () => ({ Bonjour: class {
  find(_options: object, found: (service: object) => void) { queueMicrotask(() => raop.services.forEach(found)); return { stop() {} }; }
  destroy() {}
} }));
vi.mock('../raop/stream.js', () => ({ RaopStream: class {
  profile: 'legacy' | 'airplay2';
  constructor(...args: unknown[]) {
    raop.created.push(args);
    const txt = args[2];
    this.profile = txt !== null && typeof txt === 'object' && 'ft' in txt && txt.ft === '0x0,0x40' ? 'airplay2' : 'legacy';
  }
  stream(...args: unknown[]) { return raop.stream(...args); }
} }));
vi.mock('../cli/raop-input.js', () => ({ openRaopInput: raopInput.open }));
import { main as run } from '../cli/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { scan } from '../discovery.js';

beforeEach(() => {
  vi.clearAllMocks();
  raop.services = []; raop.created = []; raop.stream.mockResolvedValue(undefined);
  raopInput.open.mockResolvedValue({ source: Buffer.alloc(4), close: vi.fn() });
  vi.stubEnv('ATV_SETTLE_MS', '0');
  vi.stubEnv('ATV_POST_SEND_MS', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(AppleTV.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'connectCompanion').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(DmapClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(DmapClient.prototype, 'close').mockImplementation(() => {});
  vi.mocked(scan).mockResolvedValue([{ name: 'TV', deviceId: 'device', address: '127.0.0.1', port: 1, companionPort: 2, dmapPort: 3, model: 'test' }]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** No credential, discovery or network access may happen for invalid arguments. */
function expectNoIo(): void {
  expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  expect(AppleTV.prototype.connectCompanion).not.toHaveBeenCalled();
  expect(DmapClient.prototype.connect).not.toHaveBeenCalled();
  expect(readFileSync).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(raop.created).toHaveLength(0);
}

describe('button action modes', () => {
  it.each([
    ['command', 'play', 'hold'], ['command', 'home_hold', 'doubleTap'], ['command', 'up', 'bogus', 'device'],
    ['command', 'up', 'hold', 'device', 'extra'],
  ])('rejects %j before connecting', async (...args) => {
    await expect(run(args)).rejects.toThrow();
    expectNoIo();
  });
  it.each([['command', 'up', 'hold2', 'device'], ['click', 'bogus', 'device']])(
    'names an invalid action in the action position of %j', async (...args) => {
      await expect(run(args)).rejects.toThrow('Invalid action');
      expectNoIo();
    });
});

describe('touch', () => {
  it.each([
    ['swipe', '100', '500', '900', '500'], ['swipe', '1001', '0', '0', '0', '10'], ['swipe', '0.5', '0', '0', '0', '10'],
    ['swipe', '0', '0', '0', '0', '0'], ['swipe', '0', '0', '0', '0', '60001'], ['swipe', '0', '0', '0', '0', '10', 'device', 'extra'],
    ['click', 'hold', 'device', 'extra'],
  ])('rejects %j before connecting', async (...args) => {
    await expect(run(args)).rejects.toThrow();
    expectNoIo();
  });
});

describe('output routing', () => {
  it('lists selected outputs over MRP', async () => {
    vi.spyOn(AppleTV.prototype, 'outputDevices', 'get').mockReturnValue([{ name: 'Kitchen', identifier: 'psi-uuid' }]);
    await run(['output', 'list', 'device']);
    expect(console.log).toHaveBeenCalledWith('psi-uuid\tKitchen');
    expect(AppleTV.prototype.connect).toHaveBeenCalledOnce();
    expect(AppleTV.prototype.connectCompanion).not.toHaveBeenCalled();
  });
  it.each([['output'], ['output', 'bad'], ['output', 'add'], ['output', 'add', 'a,,b'], ['output', 'set', ' '], ['output', 'list', 'device', 'extra'],
    ['output', 'add', 'a,a'], ['output', 'remove', 'a, a', 'device']])(
    'rejects %j before connecting', async (...args) => {
      await expect(run(args)).rejects.toThrow();
      expectNoIo();
    });
  it('scan prints each AirPlay receiver psi for use as an output ID', async () => {
    vi.mocked(scan).mockResolvedValue([
      { name: 'Kitchen', address: '192.0.2.8', port: 7000, model: 'AudioAccessory5,1', airplayPsi: 'psi-uuid' },
      { name: 'Old TV', address: '192.0.2.5', port: 0, model: 'Legacy DMAP device' },
    ] as never);
    await run(['scan']);
    expect(console.log).toHaveBeenCalledWith('  1. Kitchen (192.0.2.8:7000) [AudioAccessory5,1] psi=psi-uuid');
    expect(console.log).toHaveBeenCalledWith('  2. Old TV (192.0.2.5:0) [Legacy DMAP device]');
  });
});

describe('DMAP', () => {
  it('prints now-playing state', async () => {
    vi.spyOn(DmapClient.prototype, 'getState').mockResolvedValue(new NowPlayingInfo({ playbackState: PlaybackState.Playing }, { title: 'Song' }));
    await run(['dmap', 'state']);
    expect(console.log).toHaveBeenCalledWith('Song [Playing]');
  });
  it('closes after a failed command', async () => {
    vi.spyOn(DmapClient.prototype, 'play').mockRejectedValue(new Error('DMAP HTTP 500'));
    await expect(run(['dmap', 'play'])).rejects.toThrow('DMAP HTTP 500');
    expect(DmapClient.prototype.close).toHaveBeenCalledOnce();
  });
  /** Mock one legacy TV and capture the options DmapPairing was started with. */
  function mockPairing(): { options?: { address: string; pin: string } } {
    vi.mocked(scan).mockResolvedValue([{ name: 'Old TV', deviceId: 'dmap:old', address: '192.0.2.5', port: 0, model: 'Legacy DMAP device', dmapPort: 3689 }] as never);
    const captured: { options?: { address: string; pin: string } } = {};
    vi.spyOn(DmapPairing.prototype, 'start').mockImplementation(async function (this: DmapPairing) {
      captured.options = (this as unknown as { options: { address: string; pin: string } }).options;
    });
    vi.spyOn(DmapPairing.prototype, 'close').mockResolvedValue(undefined);
    return captured;
  }
  it('pairs by advertising a remote and stores the GUID for the selected device', async () => {
    const captured = mockPairing();
    vi.spyOn(DmapPairing.prototype, 'finish').mockReturnValue('0xAAAAAAAAAAAAAAAA');
    await run(['dmap-pair', '192.0.2.10']);
    expect(DmapPairing.prototype.start).toHaveBeenCalledOnce();
    expect(DmapPairing.prototype.close).toHaveBeenCalledOnce();
    expect(captured.options?.address).toBe('192.0.2.10');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`PIN ${captured.options?.pin}.`));
    // The shared FileStorage adapter atomically saves the new GUID; legacy files stay untouched.
  });
  it('stops polling and reports a locked-out pairing', async () => {
    mockPairing();
    vi.spyOn(DmapPairing.prototype, 'finish').mockImplementation(() => { throw new Error('DMAP pairing locked after five wrong PINs'); });
    await expect(run(['dmap-pair', '192.0.2.10'])).rejects.toThrow('locked');
    expect(DmapPairing.prototype.finish).toHaveBeenCalledOnce();
    expect(DmapPairing.prototype.close).toHaveBeenCalledOnce();
    expect(writeFileSync).not.toHaveBeenCalled();
  });
  it('closes the pairing server on Ctrl+C', async () => {
    mockPairing();
    vi.spyOn(DmapPairing.prototype, 'finish').mockImplementation(() => { throw new Error('DMAP remote is not paired'); });
    const listeners = process.listenerCount('SIGINT');
    const pending = run(['dmap-pair', '192.0.2.10']);
    await vi.waitFor(() => expect(DmapPairing.prototype.finish).toHaveBeenCalled());
    process.emit('SIGINT');
    await expect(pending).rejects.toThrow('DMAP pairing cancelled');
    expect(DmapPairing.prototype.close).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
  it.each([['dmap'], ['dmap', 'bogus'], ['dmap', 'up', 'device', 'extra'], ['dmap-pair'], ['dmap-pair', 'not-an-ip'], ['dmap-pair', 'fe80::1']])(
    'rejects %j before connecting', async (...args) => {
      await expect(run(args)).rejects.toThrow();
      expectNoIo();
    });
});

describe('RAOP streaming', () => {
  it.each([
    { profile: 'airplay2', txt: { ft: '0x0,0x40' }, selection: [] },
    { profile: 'legacy', txt: {}, selection: ['--device', 'device'] },
  ])('rejects incompatible $profile credential selection and releases the opened source', async ({ txt, selection }) => {
    const opened = Readable.from([Buffer.alloc(4)]);
    raopInput.open.mockResolvedValue({ source: opened, close: () => { opened.destroy(); } });
    raop.services = [{ addresses: ['192.0.2.7'], port: 7000, txt: { cn: '0,1', et: '0', sr: '44100', ...txt } }];
    await expect(run(['raop-stream', '192.0.2.7', 'track.pcm', ...selection])).rejects.toBeInstanceOf(Error);
    expect(opened.destroyed).toBe(true);
    expect(raop.stream).not.toHaveBeenCalled();
  });
  it('fails when no receiver advertises at the address', async () => {
    vi.useFakeTimers();
    try {
      const pending = expect(run(['raop-stream', '192.0.2.7', 'track.pcm'])).rejects.toThrow('No _raop._tcp service');
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
    } finally { vi.useRealTimers(); }
    expect(raop.created).toHaveLength(0);
  });
  it.each([['raop-stream'], ['raop-stream', '192.0.2.7'], ['raop-stream', 'host.local', 'a.pcm'], ['raop-stream', '192.0.2.7', 'a.pcm', 'extra']])(
    'rejects %j before discovery', async (...args) => {
      await expect(run(args)).rejects.toThrow();
      expectNoIo();
    });
});
