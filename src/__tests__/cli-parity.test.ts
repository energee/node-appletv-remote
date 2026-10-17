/** CLI wiring for action modes, touch, output routing, DMAP and RAOP, without hardware or real credentials. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { DmapClient } from '../dmap/client.js';
import { DmapPairing } from '../dmap/pairing.js';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';
import { Readable } from 'node:stream';

const raop = vi.hoisted(() => ({ services: [] as object[], created: [] as unknown[][], stream: vi.fn() }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: vi.fn(() => true), readFileSync: vi.fn((path: string) => path.endsWith('.atv-dmap.json') ? '{"device":"0x0123456789ABCDEF"}' : '{"device":"modern-credentials"}'), writeFileSync: vi.fn(), createReadStream: vi.fn(() => Readable.from([])) }));
vi.mock('node:readline', () => ({ createInterface: () => ({ question: (_q: string, answer: (value: string) => void) => answer('1'), close() {} }) }));
vi.mock('../credentials.js', () => ({ Credentials: { deserialize: () => ({ companionCredentials: {} }) } }));
vi.mock('../cli/device-cache.js', () => ({ withCachedDevice: async (_file: string, _id: string, _scan: unknown, connect: (device: object) => Promise<unknown>) => connect({ name: 'TV', deviceId: 'device', address: '127.0.0.1', port: 1, companionPort: 2, dmapPort: 3 }) }));
vi.mock('../discovery.js', async importOriginal => ({ ...(await importOriginal<typeof import('../discovery.js')>()), scan: vi.fn() }));
vi.mock('bonjour-service', () => ({ Bonjour: class {
  find(_options: object, found: (service: object) => void) { queueMicrotask(() => raop.services.forEach(found)); return { stop() {} }; }
  destroy() {}
} }));
vi.mock('../raop/stream.js', () => ({ RaopStream: class {
  constructor(...args: unknown[]) { raop.created.push(args); }
  stream(...args: unknown[]) { return raop.stream(...args); }
} }));
import { main as run } from '../cli/index.js';
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { scan } from '../discovery.js';

beforeEach(() => {
  vi.clearAllMocks();
  raop.services = []; raop.created = []; raop.stream.mockResolvedValue(undefined);
  vi.stubEnv('ATV_SETTLE_MS', '0');
  vi.stubEnv('ATV_POST_SEND_MS', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(AppleTV.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'connectCompanion').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(DmapClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(DmapClient.prototype, 'close').mockImplementation(() => {});
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
    [['command', 'up', 'doubleTap'], ['up', 'doubleTap']],
    [['command', 'home', 'hold', 'device'], ['home', 'hold']],
    [['cmd', 'select', 'singleTap', 'device'], ['select', 'singleTap']],
    // Without an action the key passes undefined, taking the library's singleTap default.
    [['command', 'menu', 'device'], ['menu', undefined]],
    // Action words are case-insensitive, so a miscased action never becomes a device selector.
    [['command', 'up', 'doubletap'], ['up', 'doubleTap']],
    [['command', 'up', 'HOLD', 'device'], ['up', 'hold']],
  ] as const)('sends %j as an MRP key with its action', async (args, expected) => {
    const send = vi.spyOn(AppleTV.prototype, 'sendKeyCommand').mockResolvedValue(undefined);
    await run([...args]);
    expect(send).toHaveBeenCalledWith(...expected);
    expect(AppleTV.prototype.connect).toHaveBeenCalledOnce();
  });
  it('passes the action to Companion buttons', async () => {
    const guide = vi.spyOn(AppleTV.prototype, 'guide').mockResolvedValue(undefined);
    await run(['command', 'guide', 'hold', 'device']);
    expect(guide).toHaveBeenCalledWith('hold');
    expect(AppleTV.prototype.connectCompanion).toHaveBeenCalledOnce();
  });
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
  it.each([[['click'], [undefined]], [['click', 'doubleTap', 'device'], ['doubleTap']], [['click', 'device'], [undefined]], [['click', 'Hold', 'device'], ['hold']]] as const)(
    'clicks %j over Companion only', async (args, expected) => {
      const click = vi.spyOn(AppleTV.prototype, 'click').mockResolvedValue(undefined);
      await run([...args]);
      expect(click).toHaveBeenCalledWith(...expected);
      expect(AppleTV.prototype.connectCompanion).toHaveBeenCalledOnce();
      expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
      expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
    });
  it('swipes over Companion only', async () => {
    const swipe = vi.spyOn(AppleTV.prototype, 'swipe').mockResolvedValue(undefined);
    await run(['swipe', '100', '500', '900', '500', '250', 'device']);
    expect(swipe).toHaveBeenCalledWith(100, 500, 900, 500, 250);
    expect(AppleTV.prototype.connectCompanion).toHaveBeenCalledOnce();
    expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
  });
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
  it.each([['add', 'addOutputDevices'], ['remove', 'removeOutputDevices'], ['set', 'setOutputDevices']] as const)(
    '%s splits comma-separated IDs and prints the confirmed outputs', async (action, method) => {
      const modify = vi.spyOn(AppleTV.prototype, method).mockResolvedValue(undefined);
      vi.spyOn(AppleTV.prototype, 'outputDevices', 'get').mockReturnValue([{ name: 'Kitchen', identifier: 'a' }]);
      await run(['output', action, 'a,b', 'device']);
      expect(modify).toHaveBeenCalledWith(['a', 'b']);
      expect(console.log).toHaveBeenCalledWith('a\tKitchen');
      expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
    });
  it('trims whitespace around comma-separated IDs', async () => {
    const add = vi.spyOn(AppleTV.prototype, 'addOutputDevices').mockResolvedValue(undefined);
    vi.spyOn(AppleTV.prototype, 'outputDevices', 'get').mockReturnValue([]);
    await run(['output', 'add', 'a, b', 'device']);
    expect(add).toHaveBeenCalledWith(['a', 'b']);
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
  it('documents the psi UUID requirement in help', async () => {
    await run(['--help']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('psi'));
  });
});

describe('DMAP', () => {
  it.each([
    ['up', 'up'], ['top_menu', 'topMenu'], ['play_pause', 'playPause'], ['next', 'next'], ['stop', 'stop'], ['volume_up', 'volumeUp'], ['volume_down', 'volumeDown'],
  ] as const)('sends %s with the stored pairing GUID', async (command, method) => {
    const call = vi.spyOn(DmapClient.prototype, method).mockResolvedValue(undefined);
    await run(['dmap', command, 'device']);
    expect(readFileSync).toHaveBeenCalledWith(expect.stringMatching(/\.atv-dmap\.json$/), 'utf-8');
    expect(readFileSync).not.toHaveBeenCalledWith(expect.stringMatching(/\.atv-credentials\.json$/), expect.anything());
    expect(DmapClient.prototype.connect).toHaveBeenCalledWith('0x0123456789ABCDEF');
    expect(call).toHaveBeenCalledOnce();
    expect(DmapClient.prototype.close).toHaveBeenCalledOnce();
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  });
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
    expect(writeFileSync).toHaveBeenCalledOnce();
    const [path, written] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toMatch(/\.atv-dmap\.json$/);
    // Existing DMAP pairings are kept; modern credentials are never read or rewritten.
    expect(JSON.parse(written as string)).toEqual({ device: '0x0123456789ABCDEF', 'dmap:old': '0xAAAAAAAAAAAAAAAA' });
    expect(readFileSync).not.toHaveBeenCalledWith(expect.stringMatching(/\.atv-credentials\.json$/), expect.anything());
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
  it('resolves the receiver TXT over mDNS and streams the PCM file', async () => {
    raop.services = [
      { addresses: ['192.0.2.99'], port: 5000, txt: { cn: '9' } },
      { addresses: ['192.0.2.7'], port: 7000, txt: { CN: '0,1', et: '0', SR: 44100 } },
    ];
    await run(['raop-stream', '192.0.2.7', 'track.pcm']);
    expect(raop.created).toEqual([['192.0.2.7', 7000, { cn: '0,1', et: '0', sr: '44100' }]]);
    expect(createReadStream).toHaveBeenCalledWith('track.pcm', { highWaterMark: 65536 });
    expect(raop.stream).toHaveBeenCalledWith(expect.anything(), { signal: expect.any(AbortSignal) });
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
