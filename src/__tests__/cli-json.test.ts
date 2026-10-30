/** Machine output, state ordering, bounded queues and failure cleanup are public CLI behavior. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppleTV, PowerState } from '../appletv.js';
import { MediaSubType, MediaType, NowPlayingInfo, PlaybackState } from '../now-playing-info.js';

const input = vi.hoisted(() => ({ companion: false, airplay: true, second: false, discoveryError: undefined as Error | undefined }));
vi.mock('node:fs', () => ({ realpathSync: (path: string) => path, existsSync: vi.fn(() => true), readFileSync: vi.fn(() => '{"device":"credentials"}'), writeFileSync: vi.fn(), createReadStream: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  readFile: async () => JSON.stringify({ version: 1, devices: [{
    key: 'device', aliases: ['device'], credentials: {
      ...(input.airplay ? { airplay: { clientId: 'client', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server' } } : {}),
      ...(input.companion ? { companion: { clientId: 'companion', clientLTSK: 'd'.repeat(64), clientLTPK: 'e'.repeat(64), serverLTPK: 'f'.repeat(64), serverId: 'server' } } : {}),
    },
  }, ...(input.second ? [{ key: 'device-2', aliases: ['device-2'], credentials: {
    airplay: { clientId: 'client2', clientLTSK: 'a'.repeat(64), clientLTPK: 'b'.repeat(64), serverLTPK: 'c'.repeat(64), serverId: 'server2' },
  } }] : [])] }),
  mkdir: async () => {}, writeFile: async () => {}, chmod: async () => {}, rename: async () => {}, rm: async () => {},
}));
vi.mock('../discovery.js', () => ({ scan: vi.fn() }));
import { main } from '../cli/index.js';
import { scan } from '../discovery.js';

type WriteCallback = (error?: Error | null) => void;
interface RecordLine { type: string; command: string; deviceId?: string; data: Record<string, unknown> }
let lines: string[];
function records(): RecordLine[] { return lines.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordLine); }
function capture(chunk: string | Uint8Array, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean {
  lines.push(String(chunk));
  const done = typeof encoding === 'function' ? encoding : callback;
  queueMicrotask(() => done?.());
  return true;
}
beforeEach(() => {
  lines = []; input.companion = false; input.airplay = true; input.second = false; input.discoveryError = undefined;
  vi.clearAllMocks();
  vi.mocked(scan).mockImplementation(async () => {
    if (input.discoveryError) throw input.discoveryError;
    return [{ name: 'TV', deviceId: 'device', address: '127.0.0.1', port: 1, companionPort: 2, model: 'test' }];
  });
  vi.stubEnv('ATV_SETTLE_MS', '0'); vi.stubEnv('ATV_POST_SEND_MS', '0');
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(AppleTV.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'connectCompanion').mockResolvedValue(undefined);
  vi.spyOn(AppleTV.prototype, 'close').mockResolvedValue(undefined);
  process.exitCode = undefined;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

it('writes a typed empty scan result without human progress', async () => {
  vi.mocked(scan).mockResolvedValue([]);
  await main(['--json', 'scan']);
  expect(records()).toMatchObject([{ type: 'result', command: 'scan', data: { devices: [] } }]);
});

it('preserves zero-valued normalized playback and the resolved ID for a partial selector', async () => {
  vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(new NowPlayingInfo(
    { hasPlayback: true, playbackState: PlaybackState.Paused }, { title: 'Song', elapsedTime: 0, playbackRate: 0 },
  ));
  await main(['state', '--json', 'DEV']);
  expect(records()).toMatchObject([{ type: 'result', command: 'state', deviceId: 'device',
    data: {
      hasPlayback: true, title: 'Song', playbackState: 'paused', duration: null, elapsedTime: 0, playbackRate: 0,
      mediaType: null, mediaSubType: null, seriesName: null, seasonNumber: null, episodeNumber: null,
      contentIdentifier: null, uniqueIdentifier: null, iTunesStoreIdentifier: null,
      iTunesStoreSubscriptionIdentifier: null, iTunesStoreArtistIdentifier: null, iTunesStoreAlbumIdentifier: null,
      shuffleState: null, repeatState: null,
    } }]);
});

it('represents normalized metadata in JSON state without changing unknown values', async () => {
  vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(new NowPlayingInfo(
    { hasPlayback: true }, {
      mediaType: MediaType.Video, mediaSubType: MediaSubType.Podcast, seriesName: 'Series',
      seasonNumber: 0, episodeNumber: 0, contentIdentifier: 'content', uniqueIdentifier: '42',
      iTunesStoreIdentifier: '9007199254740993', iTunesStoreSubscriptionIdentifier: '8',
      iTunesStoreArtistIdentifier: '9', iTunesStoreAlbumIdentifier: '10', shuffleState: 3, repeatState: 2,
    },
  ));
  await main(['--json', 'state']);
  expect(records()).toMatchObject([{ data: {
    mediaType: 'video', mediaSubType: 'podcast', seriesName: 'Series',
    seasonNumber: 0, episodeNumber: 0, contentIdentifier: 'content', uniqueIdentifier: '42',
    iTunesStoreIdentifier: '9007199254740993', iTunesStoreSubscriptionIdentifier: '8',
    iTunesStoreArtistIdentifier: '9', iTunesStoreAlbumIdentifier: '10', shuffleState: 'songs', repeatState: 'track',
  } }]);
});

it('does not promote missing or nonfinite timing to zero in a reported playback update', async () => {
  vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(new NowPlayingInfo(
    { hasPlayback: true }, { title: 'Song', elapsedTime: NaN, playbackRate: Infinity },
  ));
  await main(['--json', 'state']);
  expect(records()).toMatchObject([{ data: { title: 'Song', duration: null, elapsedTime: null, playbackRate: null } }]);
});

it('emits only stable scalar queue metadata, not binary or raw protocol fields', async () => {
  vi.spyOn(AppleTV.prototype, 'requestPlaybackQueue').mockResolvedValue({ '.setStateMessage': { playbackQueue: { contentItems: [{
    identifier: 'track', artworkData: Buffer.from('private image'), metadata: { title: 'Song', trackArtistName: 'Artist', albumName: 'Album', purchaseInfoData: Buffer.from('private purchase') },
  }] } } });
  await main(['--json', 'queue']);
  expect(records()[0]).toMatchObject({ deviceId: 'device', data: { items: [{ id: 'track', title: 'Song', artist: 'Artist', album: 'Album' }] } });
  expect(JSON.stringify(records())).not.toContain('private');
});

it.each([['--json', 'seek', 'invalid'], ['--json', '--json', 'state']])('reports invalid arguments once before connection: %j', async (...args) => {
  await main(args);
  expect(records()).toMatchObject([{ type: 'error', data: { code: 'invalid_arguments' } }]);
  expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
});

it('rejects prompt and raw diagnostic modes before connection', async () => {
  await main(['--json', 'pair']);
  expect(records()).toMatchObject([{ type: 'error', data: { code: 'unsupported' } }]);
  expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
});

it.each(['state', 'power'])('keeps the resolved ID when %s discovery fails before creating a transport', async command => {
  input.companion = true; input.discoveryError = new Error('Discovery timed out');
  await main(['--json', command, 'DEV']);
  expect(records()).toMatchObject([{ type: 'error', deviceId: 'device', data: { code: 'transport_error' } }]);
  expect(AppleTV.prototype.connect).not.toHaveBeenCalled();
  expect(AppleTV.prototype.connectCompanion).not.toHaveBeenCalled();
});

it('keeps protocol status and drops arbitrary private error payloads', async () => {
  vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockRejectedValue(Object.assign(new Error('private-key-material'), { errorCode: 7 }));
  await main(['--json', 'state']);
  expect(records()).toMatchObject([{ type: 'error', deviceId: 'device', data: { code: 'protocol_error', protocolCode: 7 } }]);
  expect(lines.join('')).not.toContain('private-key-material');
});

it('categorizes the actual unfocused-text error', async () => {
  input.companion = true;
  vi.spyOn(AppleTV.prototype, 'setText').mockRejectedValue(new Error('No text field is focused'));
  await main(['--json', 'text', 'set', 'hello']);
  expect(records()).toMatchObject([{ type: 'error', deviceId: 'device', data: { code: 'text_unfocused' } }]);
});

it('drains the terminal result before completing under backpressure', async () => {
  vi.mocked(scan).mockResolvedValue([]);
  let flush: WriteCallback | undefined;
  vi.mocked(process.stdout.write).mockImplementation((chunk, encoding, callback) => {
    lines.push(String(chunk)); flush = typeof encoding === 'function' ? encoding : callback; return false;
  });
  let complete = false;
  const command = main(['--json', 'scan']).then(() => { complete = true; });
  await vi.waitFor(() => expect(flush).toBeTypeOf('function'));
  expect(complete).toBe(false);
  flush!(); await command;
  expect(records()).toMatchObject([{ type: 'result', command: 'scan', data: { devices: [] } }]);
});

it('turns an asynchronously closed pipe into bounded command failure and removes handlers', async () => {
  vi.mocked(scan).mockResolvedValue([]);
  const listeners = process.stdout.listenerCount('error');
  let written = false;
  vi.mocked(process.stdout.write).mockImplementation(() => { written = true; return false; });
  const command = main(['--json', 'scan']);
  await vi.waitFor(() => expect(written).toBe(true));
  process.stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await command;
  expect(process.exitCode).toBe(1);
  expect(process.stdout.listenerCount('error')).toBe(listeners);
});

it('preserves MRP power observed during setup without a Companion pairing', async () => {
  let tv: AppleTV | undefined;
  vi.mocked(AppleTV.prototype.connect).mockImplementation(async function (this: AppleTV) {
    tv = this;
    this.powerState = PowerState.On;
    this.emit('powerState', PowerState.On);
  });
  const watching = main(['--json', 'watch']);
  try {
    await vi.waitFor(() => expect(records().some(record => record.command === 'source')).toBe(true));
    tv!.powerState = PowerState.Off;
    tv!.emit('powerState', PowerState.Off);
  } finally { process.emit('SIGINT'); await watching; }
  expect(records().filter(record => record.command === 'power').map(record => record.data))
    .toEqual([{ state: 'on' }, { state: 'off' }]);
  expect(records().at(-1)).toMatchObject({ command: 'watch-close', data: { reason: 'signal' } });
  expect(process.exitCode).toBe(130);
});

it('publishes cached MRP power when setup did not emit a power event', async () => {
  vi.mocked(AppleTV.prototype.connect).mockImplementation(async function (this: AppleTV) {
    this.powerState = PowerState.Off;
  });
  const watching = main(['--json', 'watch']);
  try {
    await vi.waitFor(() => expect(records().some(record => record.command === 'power')).toBe(true));
  } finally { process.emit('SIGINT'); await watching; }
  expect(records().filter(record => record.command === 'power').map(record => record.data))
    .toEqual([{ state: 'off' }]);
});

it('emits initial unknowns, normalized updates and a single last unexpected-loss record', async () => {
  let tv: AppleTV | undefined;
  vi.spyOn(AppleTV.prototype, 'connect').mockImplementation(async function (this: AppleTV) { tv = this; });
  const watching = main(['--json', 'watch']);
  await vi.waitFor(() => expect(records().some(record => record.command === 'source')).toBe(true));
  tv!.emit('nowPlaying', new NowPlayingInfo({ hasPlayback: true, playbackState: PlaybackState.Paused }, {
    title: 'Changed', mediaType: MediaType.Video, seasonNumber: 0, uniqueIdentifier: '9007199254740993',
  }));
  tv!.emit('volume', 32.5); tv!.emit('close');
  await watching;
  const result = records();
  expect(result.find(record => record.command === 'playback')).toMatchObject({ data: { state: 'unknown' } });
  expect(result.find(record => record.command === 'power')?.data).toEqual({ state: 'unknown' });
  expect(result.find(record => record.data.title === 'Changed')).toMatchObject({ data: {
    playbackState: 'paused', mediaType: 'video', seasonNumber: 0, uniqueIdentifier: '9007199254740993',
  } });
  expect(result.at(-1)).toMatchObject({ command: 'connection-close', data: { intentional: false, transport: 'mrp' } });
  expect(result.filter(record => record.command === 'connection-close')).toHaveLength(1);
  expect(process.exitCode).toBe(1);
  expect(tv!.listenerCount('nowPlaying')).toBe(0);
});

it('coalesces state within a bounded backlog without dropping the final value or terminal record', async () => {
  let tv: AppleTV | undefined; let flush: WriteCallback | undefined;
  vi.spyOn(AppleTV.prototype, 'connect').mockImplementation(async function (this: AppleTV) { tv = this; });
  vi.mocked(process.stdout.write).mockImplementation((chunk, encoding, callback) => {
    if (!flush) { lines.push(String(chunk)); flush = typeof encoding === 'function' ? encoding : callback; return false; }
    return capture(chunk, encoding, callback);
  });
  const watching = main(['--json', 'watch']);
  await vi.waitFor(() => expect(flush).toBeTypeOf('function'));
  for (let index = 0; index < 400; index++) tv!.emit('volume', index % 101);
  tv!.emit('close'); flush!();
  await watching;
  const result = records();
  expect(result.filter(record => record.command === 'volume').at(-1)).toMatchObject({ data: { value: 96, state: 'known' } });
  expect(result.at(-1)).toMatchObject({ command: 'connection-close', data: { intentional: false } });
  expect(result.length).toBeLessThanOrEqual(129);
});

it('closes a watch on EPIPE instead of leaving subscriptions alive', async () => {
  let tv: AppleTV | undefined; let written = false;
  vi.spyOn(AppleTV.prototype, 'connect').mockImplementation(async function (this: AppleTV) { tv = this; });
  vi.mocked(process.stdout.write).mockImplementation(() => { written = true; return false; });
  const watching = main(['--json', 'watch']);
  await vi.waitFor(() => expect(written).toBe(true));
  process.stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  await watching;
  expect(process.exitCode).toBe(1);
  expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  expect(tv!.listenerCount('nowPlaying')).toBe(0);
});

it('finishes owned watch cleanup before rejecting a stalled output deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let wrote!: () => void; let tv: AppleTV | undefined;
  const firstWrite = new Promise<void>(resolve => { wrote = resolve; });
  vi.spyOn(AppleTV.prototype, 'connect').mockImplementation(async function (this: AppleTV) { tv = this; });
  vi.mocked(process.stdout.write).mockImplementation(() => { wrote(); return false; });
  const watching = main(['--json', 'watch']);
  const failed = expect(watching).rejects.toThrow('JSON output did not drain within 2000ms');
  await firstWrite;
  await vi.advanceTimersByTimeAsync(2000); await failed;
  expect(process.exitCode).toBe(1);
  expect(AppleTV.prototype.close).toHaveBeenCalledTimes(1);
  expect(tv!.listenerCount('nowPlaying')).toBe(0);
});

it('cancels setup with one terminal outcome and no cleanup-generated events', async () => {
  let rejectSetup: ((error: Error) => void) | undefined;
  vi.spyOn(AppleTV.prototype, 'connect').mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectSetup = reject; }));
  vi.mocked(AppleTV.prototype.close).mockImplementation(async () => { rejectSetup?.(new Error('closed during setup')); });
  const watching = main(['--json', 'watch']);
  await vi.waitFor(() => expect(rejectSetup).toBeTypeOf('function'));
  process.emit('SIGINT'); await watching;
  expect(records()).toMatchObject([{ command: 'watch-close', data: { reason: 'signal', signal: 'SIGINT', intentional: true } }]);
  expect(process.exitCode).toBe(130);
});

it('reports an ambiguous device selector as invalid_arguments', async () => {
  input.second = true;
  await main(['--json', 'state', 'dev']);
  expect(records()).toMatchObject([{ type: 'error', command: 'state', data: { code: 'invalid_arguments' } }]);
});

it('reports an operation no stored pairing can perform as credentials_unavailable', async () => {
  input.airplay = false; input.companion = true;
  await main(['--json', 'state']);
  expect(records()).toMatchObject([{ type: 'error', command: 'state', data: { code: 'credentials_unavailable' } }]);
});

it('reports Companion setup failure once without mislabeling cleanup as unexpected loss', async () => {
  input.companion = true;
  vi.mocked(AppleTV.prototype.connectCompanion).mockRejectedValue(new Error('Companion setup failed'));
  vi.mocked(AppleTV.prototype.close).mockImplementation(async function (this: AppleTV) { this.emit('close'); this.emit('companionClose'); });
  await main(['--json', 'watch']);
  expect(records().filter(record => record.type === 'error')).toMatchObject([{ deviceId: 'device', data: { code: 'operation_failed' } }]);
  expect(records().at(-1)?.type).toBe('error');
  expect(records().some(record => record.command === 'connection-close')).toBe(false);
});

it('rejects an oversized structured record with a bounded safe terminal error', async () => {
  vi.spyOn(AppleTV.prototype, 'getNowPlaying').mockResolvedValue(new NowPlayingInfo({ hasPlayback: true }, { title: 'x'.repeat(1024 * 1024) }));
  await main(['--json', 'state']);
  expect(records()).toMatchObject([{ type: 'error', data: { code: 'output_limit' } }]);
  expect(Buffer.byteLength(lines.join(''))).toBeLessThan(1024);
});
