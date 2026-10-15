/** CLI argument validation and dispatch without credentials, discovery, or hardware. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleTV, ShuffleState, RepeatState } from '../appletv.js';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';

vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: vi.fn(() => true), readFileSync: vi.fn(() => '{"device":"fake"}'), writeFileSync: vi.fn() }));
vi.mock('../credentials.js', () => ({ Credentials: { deserialize: () => ({ companionCredentials: {} }) } }));
vi.mock('../cli/device-cache.js', () => ({ withCachedDevice: async (_file: string, _id: string, _scan: unknown, connect: (device: { name: string; deviceId: string; address: string; port: number; companionPort: number }) => Promise<unknown>) => connect({ name: 'TV', deviceId: 'device', address: '127.0.0.1', port: 1, companionPort: 2 }) }));
vi.mock('../discovery.js', () => ({ scan: vi.fn() }));
import { main as run } from '../cli/index.js';
import { readFileSync } from 'node:fs';
import { scan } from '../discovery.js';


beforeEach(() => {
  vi.clearAllMocks();
  // Explicit zero must disable both CLI waits (and keeps these tests fast).
  vi.stubEnv('ATV_SETTLE_MS', '0');
  vi.stubEnv('ATV_POST_SEND_MS', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(AppleTV.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'connectCompanion').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'close').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('CLI timing defaults', () => {
  it('settles 500 ms after connect and waits 1000 ms before disconnecting unless overridden', async () => {
    vi.unstubAllEnvs();
    vi.useFakeTimers();
    vi.spyOn(AppleTV.prototype, 'sendKeyCommand').mockResolvedValue(undefined);
    const done = run(['command', 'select']);
    await vi.advanceTimersByTimeAsync(999);
    expect(AppleTV.prototype.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(AppleTV.prototype.connect).toHaveBeenCalledWith(expect.anything(), { settleMs: 500 });
    expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
  });
  it.each([[['power'], 'fetchPowerState', 'on'], [['app', 'list'], 'appList', []], [['account', 'list'], 'accountList', []]] as const)(
    'skips the post-send wait for read-only %j', async (args, method, result) => {
      vi.unstubAllEnvs();
      vi.useFakeTimers();
      vi.spyOn(AppleTV.prototype, method).mockResolvedValue(result as never);
      const done = run([...args]);
      await vi.advanceTimersByTimeAsync(0);
      expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
      await done;
    });
  it('honors explicit zero for both waits', async () => {
    vi.spyOn(AppleTV.prototype, 'sendKeyCommand').mockResolvedValue(undefined);
    await run(['command', 'select']);
    expect(AppleTV.prototype.connect).toHaveBeenCalledWith(expect.anything(), { settleMs: 0 });
  });
});

describe('CLI operations', () => {
  it.each([PlaybackState.Paused, PlaybackState.Interrupted])('preserves metadata-free normalized playback state %s', async state => {
    const info = new NowPlayingInfo({ hasPlayback: true, playbackState: state }, {});
    vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(info);
    await run(['state']);
    expect(console.log).toHaveBeenCalledWith(`[${PlaybackState[state]}]`);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Absent'));
    expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
  });
  it.each([
    [['stop'], 'stop', []], [['seek', '12.5'], 'setPosition', [12.5]],
    [['skip-forward', '10'], 'skipForward', [10]], [['skip-backward', '3'], 'skipBackward', [3]],
    [['shuffle', 'albums'], 'setShuffle', [ShuffleState.Albums]], [['repeat', 'track'], 'setRepeat', [RepeatState.Track]],
    [['volume', '0'], 'setVolume', [0]], [['text', 'set', ''], 'setText', ['']],
    [['text', 'append', 'hello world'], 'insertText', ['hello world']], [['text', 'clear'], 'clearText', []],
  ] as const)('dispatches %j over MRP', async (args, method, values) => {
    const call = vi.spyOn(AppleTV.prototype, method).mockResolvedValue(undefined);
    await run([...args, 'device']);
    expect(call).toHaveBeenCalledWith(...values);
    expect(AppleTV.prototype.connect).toHaveBeenCalledTimes(1);
    expect(AppleTV.prototype.connectCompanion).not.toHaveBeenCalled();
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    [['app', 'list'], 'appList', []], [['app', 'launch', 'com.example.app'], 'launchApp', ['com.example.app']],
    [['account', 'list'], 'accountList', []], [['account', 'switch', 'user-id'], 'switchAccount', ['user-id']],
    [['power'], 'fetchPowerState', []], [['command', 'channel_up'], 'channelUp', []],
    [['cmd', 'channel_down'], 'channelDown', []], [['command', 'screensaver'], 'screensaver', []],
    [['command', 'guide'], 'guide', []], [['command', 'page_up'], 'pageUp', []], [['command', 'page_down'], 'pageDown', []],
  ] as const)('dispatches %j over Companion only', async (args, method, values) => {
    const result = method === 'appList' ? [{ name: 'App', bundleId: 'com.example.app' }] : method === 'accountList' ? [{ name: 'User', id: 'user-id' }] : method === 'fetchPowerState' ? 'on' : undefined;
    const call = vi.spyOn(AppleTV.prototype, method).mockResolvedValue(result as never);
    await run([...args, 'device']);
    expect(call).toHaveBeenCalledWith(...values);
    expect(AppleTV.prototype.connectCompanion).toHaveBeenCalledTimes(1);
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
    if (method === 'appList') expect(console.log).toHaveBeenCalledWith('com.example.app\tApp');
    if (method === 'accountList') expect(console.log).toHaveBeenCalledWith('user-id\tUser');
    if (method === 'fetchPowerState') expect(console.log).toHaveBeenCalledWith('on');
  });
  it.each([
    ['text', 'append'], ['seek', ''], ['seek', ' '], ['volume', '-1'], ['volume', '1e2'], ['shuffle', '__proto__'], ['repeat', 'constructor'], ['artwork', 'a', 'b', 'c'], ['scan', 'extra'], ['stop', ''], ['text', 'set', 'hi', ' '], ['seek'], ['seek', '-1'], ['seek', 'NaN'], ['seek', 'Infinity'], ['seek', '12junk'],
    ['skip-forward', '0'], ['skip-backward', '-3'], ['volume', '101'], ['volume', ''],
    ['shuffle', 'bad'], ['repeat', 'bad'], ['text', 'set'], ['text', 'clear', 'device', 'extra'],
    ['app', 'launch', ' '], ['account', 'switch'], ['app', 'bad'], ['power', 'device', 'extra'],
    ['command'], ['command', 'bad'], ['command', '__proto__'], ['command', 'constructor'], ['stop', 'device', 'extra'], ['unknown'],
  ])('rejects %j before connecting', async (...args) => {
    await expect(run(args)).rejects.toThrow();
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
    expect(AppleTV.prototype.connectCompanion).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });
  it.each([['state', 'getState'], ['queue', 'requestPlaybackQueue'], ['artwork', 'requestArtwork'], ['command', 'guide']])('propagates %s failures and closes', async (cmd, method) => {
    const name = cmd === 'command' ? 'guide' : method;
    vi.spyOn(AppleTV.prototype, name as 'getState').mockRejectedValue(new Error('request failed'));
    await expect(run(cmd === 'command' ? [cmd, method] : [cmd])).rejects.toThrow('request failed');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('rejects an unmatched device instead of mutating the last device', async () => {
    await expect(run(['stop', 'missing-device'])).rejects.toThrow('No paired device matches');
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  });
  it('uses the last paired device only when selector is omitted', async () => {
    const stop = vi.spyOn(AppleTV.prototype, 'stop').mockResolvedValue(undefined);
    await run(['stop']);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Connecting'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Connecting'));
  });
  it('closes and propagates operation errors', async () => {
    vi.spyOn(AppleTV.prototype, 'stop').mockRejectedValue(new Error('send failed'));
    await expect(run(['stop'])).rejects.toThrow('send failed');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('retains MRP key dispatch', async () => {
    const send = vi.spyOn(AppleTV.prototype, 'sendKeyCommand').mockResolvedValue(undefined);
    await run(['command', 'play']);
    expect(send).toHaveBeenCalledWith('play');
    expect(console.log).toHaveBeenCalledWith('Sent: play');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('closes a failed MRP connection', async () => {
    vi.mocked(AppleTV.prototype.connect).mockRejectedValue(new Error('connect failed'));
    await expect(run(['stop'])).rejects.toThrow('connect failed');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('closes a failed Companion connection', async () => {
    vi.mocked(AppleTV.prototype.connectCompanion).mockRejectedValue(new Error('connect failed'));
    await expect(run(['power'])).rejects.toThrow('connect failed');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('shows help without a connection', async () => {
    await run(['--help']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('seek'));
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  });
});
