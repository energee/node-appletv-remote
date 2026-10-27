/** CLI argument validation and dispatch without credentials, discovery, or hardware. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';

vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: vi.fn(() => true), readFileSync: vi.fn(() => '{"device":"fake"}'), writeFileSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: async () => JSON.stringify({ version: 1, devices: [{ key: 'device', aliases: ['device'], credentials: { airplay: { clientId: 'client', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server' }, companion: { clientId: 'companion', clientLTSK: 'd'.repeat(64), clientLTPK: 'e'.repeat(64), serverLTPK: 'f'.repeat(64), serverId: 'server' }, dmap: { guid: '0x0123456789ABCDEF' } }, hints: { name: 'Living Room' } }] }), mkdir: async () => {}, writeFile: async () => {}, chmod: async () => {}, rename: async () => {}, rm: async () => {} }));
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
  vi.mocked(scan).mockResolvedValue([{ name: 'TV', deviceId: 'device', address: '127.0.0.1', port: 1, companionPort: 2, dmapPort: 3, model: 'test' }]);
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
    expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
  });
  it.each([[['power'], 'fetchPowerState', 'on'], [['text', 'focus'], 'fetchTextFocusState', 'focused'], [['app', 'list'], 'appList', []], [['account', 'list'], 'accountList', []]] as const)(
    'skips the post-send wait for read-only %j', async (args, method, result) => {
      vi.unstubAllEnvs();
      vi.useFakeTimers();
      vi.spyOn(AppleTV.prototype, method).mockResolvedValue(result as never);
      const done = run([...args]);
      await vi.advanceTimersByTimeAsync(0);
      expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
      await done;
    });
  it.each([[['text', 'set', 'hi'], 'setText', 'hi'], [['text', 'append', 'hi'], 'insertText', 'hi'], [['text', 'clear'], 'clearText', '']] as const)(
    'waits before disconnecting after the unacknowledged _tiC edit of %j', async (args, method, result) => {
      vi.unstubAllEnvs();
      vi.useFakeTimers();
      vi.spyOn(AppleTV.prototype, method).mockResolvedValue(result);
      const done = run([...args]);
      await vi.advanceTimersByTimeAsync(999);
      expect(AppleTV.prototype.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
    });
});

describe('CLI operations', () => {
  it.each([PlaybackState.Playing, PlaybackState.Paused, PlaybackState.Interrupted])('preserves metadata-free normalized playback state %s', async state => {
    const info = new NowPlayingInfo({ hasPlayback: false, playbackState: state }, {});
    vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(info);
    await run(['state']);
    expect(console.log).toHaveBeenCalledWith(`[${PlaybackState[state]}]`);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Absent'));
    expect(AppleTV.prototype.close).toHaveBeenCalledOnce();
  });
  it('prints the nothing-playing line for an idle TV snapshot', async () => {
    vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(new NowPlayingInfo({ hasPlayback: false }, {}));
    await run(['state']);
    expect(console.log).toHaveBeenCalledWith('Nothing playing. [Absent]');
  });
  it.each([['state', 'getNowPlaying', new NowPlayingInfo({ hasPlayback: false }, {}), 'Requesting state...'],
    ['queue', 'requestPlaybackQueue', {}, 'Requesting playback queue...'], ['artwork', 'requestArtwork', null, 'Requesting artwork...']] as const)(
    'prints %s progress to stderr, keeping stdout for results', async (cmd, method, result, progress) => {
      vi.spyOn(AppleTV.prototype, method).mockResolvedValue(result as never);
      await run([cmd]);
      expect(console.error).toHaveBeenCalledWith(progress);
      expect(console.log).not.toHaveBeenCalledWith(progress);
    });
  it.each([
    ['text', 'append'], ['seek', ''], ['seek', ' '], ['volume', '-1'], ['volume', '1e2'], ['shuffle', '__proto__'], ['repeat', 'constructor'], ['artwork', 'a', 'b', 'c'], ['scan', 'extra'], ['stop', ''], ['text', 'set', 'hi', ' '], ['seek'], ['seek', '-1'], ['seek', 'NaN'], ['seek', 'Infinity'], ['seek', '12junk'],
    ['skip-forward', '0'], ['skip-backward', '-3'], ['volume', '101'], ['volume', ''],
    ['shuffle', 'bad'], ['repeat', 'bad'], ['text', 'set'], ['text', 'clear', 'device', 'extra'],
    ['app', 'launch', ' '], ['text', 'focus', 'device', 'extra'], ['account', 'switch'], ['app', 'bad'], ['power', 'device', 'extra'],
    ['command'], ['command', 'bad'], ['command', '__proto__'], ['command', 'constructor'], ['stop', 'device', 'extra'], ['unknown'],
  ])('rejects %j before connecting', async (...args) => {
    await expect(run(args)).rejects.toThrow();
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
    expect(AppleTV.prototype.connectCompanion).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });
  it.each([['state', 'getNowPlaying'], ['queue', 'requestPlaybackQueue'], ['artwork', 'requestArtwork'], ['command', 'guide']])('propagates %s failures and closes', async (cmd, method) => {
    const name = cmd === 'command' ? 'guide' : method;
    vi.spyOn(AppleTV.prototype, name as 'getState').mockRejectedValue(new Error('request failed'));
    await expect(run(cmd === 'command' ? [cmd, method] : [cmd])).rejects.toThrow('request failed');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('rejects an unmatched device instead of mutating the last device', async () => {
    await expect(run(['stop', 'missing-device'])).rejects.toThrow('No paired device matches');
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  });
  it('selects a device by its exact stored name in any case, but not by part of it', async () => {
    const stop = vi.spyOn(AppleTV.prototype, 'stop').mockResolvedValue(undefined);
    await run(['stop', 'living room']);
    expect(stop).toHaveBeenCalledOnce();
    await expect(run(['stop', 'living'])).rejects.toThrow('No paired device matches');
  });
  it('closes and propagates operation errors', async () => {
    vi.spyOn(AppleTV.prototype, 'stop').mockRejectedValue(new Error('send failed'));
    await expect(run(['stop'])).rejects.toThrow('send failed');
    expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  });
  it('retains MRP key dispatch', async () => {
    const send = vi.spyOn(AppleTV.prototype, 'sendKeyCommand').mockResolvedValue(undefined);
    await run(['command', 'play']);
    expect(send).toHaveBeenCalledWith('play', undefined);
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
  it('passes repeated targeted scan hosts and rejects malformed values before scan I/O', async () => {
    vi.mocked(scan).mockResolvedValue([]);
    await run(['scan', '--host', '192.0.2.8', '--host', '2001:db8::8']);
    expect(scan).toHaveBeenCalledWith({ timeout: 5000, hosts: ['192.0.2.8', '2001:db8::8'] });
    await expect(run(['scan', '--host', 'not-an-ip'])).rejects.toThrow('Invalid discovery host');
    expect(scan).toHaveBeenCalledTimes(1);
  });
  it('shows help without a connection', async () => {
    await run(['--help']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('seek'));
    expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  });
});
