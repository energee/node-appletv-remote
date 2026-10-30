/** Offline regression fixtures for MRP acknowledgments, player state, and availability. */
import { describe, it, expect } from 'vitest';
import protobuf from 'protobufjs';
import { MRP_SCHEMA } from '../mrp/schema.js';
import { AirPlayConnection } from '../connection.js';
import { Credentials } from '../credentials.js';
import { vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { MediaSubType, MediaType, PlaybackState } from '../now-playing-info.js';
import { MessageType, MRPMessage } from '../mrp/messages.js';

function device() {
  const atv = new AppleTV({ name: 'Test', address: '127.0.0.1', port: 7000, deviceId: 'test', model: '' });
  const readyTransports = Reflect.get(atv, 'readyTransports');
  let connection: unknown;
  Object.defineProperty(atv, 'connection', {
    configurable: true,
    get: () => connection,
    set: (next: unknown) => {
      connection = next;
      if (readyTransports instanceof WeakSet && next !== null && (typeof next === 'object' || typeof next === 'function')) readyTransports.add(next);
    },
  });
  return atv;
}
function deliver(atv: AppleTV, type: MessageType, field: string, payload: object) {
  (atv as any).handleMRPMessage({ type, [`.${field}`]: payload });
}
const path = (bundle: string, player = 'MediaRemote-DefaultPlayer') => ({ client: { bundleIdentifier: bundle }, player: { identifier: player } });

describe('media acknowledgments', () => {
  it.each([0, 7, 10])('interprets SendCommandResult sendError %s', async (sendError) => {
    const atv = device();
    (atv as any).connection = {
      sendMRPMessage: async () => {},
      sendMRPMessageAndWait: async (bytes: Buffer, type: number) => {
        expect((await MRPMessage.decode(bytes)).type).toBe(1);
        // Media command replies match by identifier only.
        expect(type).toBeUndefined();
        return { type: 2, '.sendCommandResultMessage': { sendError, handlerReturnStatus: 0 } };
      },
    };
    if (sendError === 0) await expect(atv.play()).resolves.toBeUndefined();
    else await expect(atv.play()).rejects.toThrow(`sendError=${sendError}`);
  });
  it('uses sendError rejection with handler diagnostics and accepts a missing result extension', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessage: async () => {}, sendMRPMessageAndWait: async () => ({ '.sendCommandResultMessage': { handlerReturnStatus: 2, sendError: 8 } }) };
    await expect(atv.pause()).rejects.toThrow('handlerReturnStatus=2');
    // No inner SendCommandResultMessage means sendError NoError.
    (atv as any).connection = { sendMRPMessage: async () => {}, sendMRPMessageAndWait: async () => ({ type: 2 }) };
    await expect(atv.pause()).resolves.toBeUndefined();
  });
  it('accepts a decoded acknowledgment whose status fields are omitted (absent sendError is NoError)', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => MRPMessage.decode(Buffer.from([8, 2, 58, 0])) };
    await expect(atv.play()).resolves.toBeUndefined();
  });
  it('rejects envelope errors even when the inner command succeeded', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => ({ type: 2, errorCode: 7, errorDescription: 'Denied', '.sendCommandResultMessage': { sendError: 0, handlerReturnStatus: 0 } }) };
    await expect(atv.play()).rejects.toThrow('errorCode=7');
  });
  it('accepts UIKitLegacy handler status when sendError is zero', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => ({ errorCode: 0, '.sendCommandResultMessage': { sendError: 0, handlerReturnStatus: 3 } }) };
    await expect(atv.play()).resolves.toBeUndefined();
  });
  it('decodes acknowledgment wire fields', async () => {
    // ProtocolMessage type 2, extension 7: sendError=10, handlerReturnStatus=2.
    const decoded = await MRPMessage.decode(Buffer.from([8, 2, 58, 4, 8, 10, 16, 2]));
    expect(decoded['.sendCommandResultMessage']).toMatchObject({ sendError: 10, handlerReturnStatus: 2 });
  });
});

describe('unified player state', () => {
  it('normalizes decoded field presence without overwriting fallback artist', async () => {
    const atv = device();
    const root = protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace);
    const proto = root.lookupType('ProtocolMessage');
    const bytes = proto.encode(proto.create({ type: 4, '.setStateMessage': { playerPath: path('app'), playbackState: 1, playbackQueue: { location: 0, contentItems: [{ identifier: 'x', metadata: { title: 'Title', albumArtistName: 'Fallback' } }] } } })).finish();
    (atv as any).handleMRPMessage(await MRPMessage.decode(Buffer.from(bytes)));
    expect(atv.nowPlaying.artist).toBe('Fallback');
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { artist: 'Direct', elapsedTime: 5 } });
    deliver(atv, MessageType.UpdateContentItem, 'updateContentItemMessage', { playerPath: path('app'), contentItems: [{ identifier: 'x', metadata: { elapsedTime: 10 } }] });
    expect(atv.nowPlaying.elapsedTime).toBe(10);
  });
  it('does not resurrect cached default player when the active player is explicitly cleared', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { title: 'Cached' } });
    deliver(atv, MessageType.SetNowPlayingPlayer, 'setNowPlayingPlayerMessage', { playerPath: { client: { bundleIdentifier: 'app' } } });
    expect(atv.nowPlaying.hasPlayback).toBe(false);
  });
  it('clears runtime state and capability evidence on close', async () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { nowPlayingInfo: { title: 'Cached' }, supportedCommands: { supportedCommands: [{ command: 1, enabled: true }] } });
    await atv.close();
    expect(atv.nowPlaying.hasPlayback).toBe(false);
    expect(atv.featureAvailability('play')).toBe('unknown');
  });

  it('clears direct metadata when its unique item identifier changes', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { nowPlayingInfo: { uniqueIdentifier: '1', title: 'Old', artist: 'Old artist' } });
    deliver(atv, MessageType.SetState, 'setStateMessage', { nowPlayingInfo: { uniqueIdentifier: '2', title: 'New' } });
    expect(atv.nowPlaying.artist).toBe('');
  });

  it('clears an old queue on a direct item transition but preserves a replacement queue', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { uniqueIdentifier: '1' },
      playbackQueue: { contentItems: [{ identifier: 'old', metadata: { seriesName: 'Old series', contentIdentifier: 'old-content' } }] } });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { uniqueIdentifier: '2' },
      playbackQueue: { contentItems: [{ identifier: 'new', metadata: { seriesName: 'New series', contentIdentifier: 'new-content' } }] } });
    expect(atv.nowPlaying).toMatchObject({ seriesName: 'New series', contentIdentifier: 'new-content' });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { uniqueIdentifier: '3' } });
    expect(atv.nowPlaying).toMatchObject({ seriesName: '', contentIdentifier: '' });
  });
  it('normalizes queue location and merges direct and item updates', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), playbackState: 1, playbackQueue: { location: 1, contentItems: [
      { identifier: 'old', metadata: { title: 'Wrong' } },
      { identifier: 'current', metadata: { title: 'Song', trackArtistName: 'Artist', albumName: 'Album', duration: 120 } },
    ] } });
    expect((atv as any).nowPlaying).toMatchObject({ title: 'Song', artist: 'Artist', album: 'Album', playbackState: PlaybackState.Playing, hasPlayback: true });
    deliver(atv, MessageType.UpdateContentItem, 'updateContentItemMessage', { playerPath: path('app'), contentItems: [{ identifier: 'current', metadata: { elapsedTime: 42 } }] });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { artist: 'Updated' }, playbackState: 2 });
    expect((atv as any).nowPlaying).toMatchObject({ title: 'Song', artist: 'Updated', elapsedTime: 42, playbackState: PlaybackState.Paused });
  });
  it('does not let inactive players overwrite the active player and clears ended playback', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('a'), nowPlayingInfo: { title: 'A' }, playbackState: 1 });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('b'), nowPlayingInfo: { title: 'B' }, playbackState: 2 });
    expect((atv as any).nowPlaying.title).toBe('A');
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'b' } });
    expect((atv as any).nowPlaying.title).toBe('B');
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('b'), playbackQueue: { contentItems: [] } });
    expect((atv as any).nowPlaying).toMatchObject({ title: '', hasPlayback: false });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('b'), playbackState: 3 });
    expect((atv as any).nowPlaying.playbackState).toBe(PlaybackState.Stopped);
  });
  it('switches players within a client and clears an absent active client', () => {
    const atv = device();
    for (const p of ['one', 'two']) deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app', p), nowPlayingInfo: { title: p } });
    deliver(atv, MessageType.SetNowPlayingPlayer, 'setNowPlayingPlayerMessage', { playerPath: path('app', 'two') });
    expect((atv as any).nowPlaying).toMatchObject({ title: 'two', playerIdentifier: 'two' });
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', {});
    expect((atv as any).nowPlaying.hasPlayback).toBe(false);
  });
  it('treats an empty now-playing client as the active client (bundle id \'\')', () => {
    const atv = device();
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', {});
    deliver(atv, MessageType.SetState, 'setStateMessage', { playbackState: 3 });
    expect(atv.nowPlaying).toMatchObject({ hasPlayback: false, playbackState: PlaybackState.Stopped });
  });
  it('retains only snapshot state fields, not queue artwork, from SetState', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), playbackState: 1, displayName: 'App',
      playbackQueue: { contentItems: [{ identifier: 'x', artworkData: Buffer.alloc(1024), metadata: { title: 'T' } }] } });
    const player = (atv as any).playerState.clients.get('app').players.get('MediaRemote-DefaultPlayer');
    expect(player.state).toEqual({ playbackState: 1, displayName: 'App' });
    expect(player.items[0].artworkData).toBeUndefined();
    expect(atv.nowPlaying).toMatchObject({ title: 'T', playbackState: PlaybackState.Playing, appDisplayName: 'App' });
  });
  it('does not retain Buffer views of the frame in nowPlayingInfo or item metadata', () => {
    const atv = device();
    const frame = Buffer.alloc(4096);
    const view = () => frame.subarray(0, 8);
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'),
      nowPlayingInfo: { title: 'D', artworkDataDigest: view() },
      playbackQueue: { contentItems: [{ identifier: 'x', metadata: { title: 'T', nowPlayingInfoData: view() } }] } });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { title: 'D', artworkDataDigest: view() } });
    deliver(atv, MessageType.UpdateContentItem, 'updateContentItemMessage', { playerPath: path('app'),
      contentItems: [{ identifier: 'x', metadata: { artworkURLTemplatesData: view() } }] });
    const player = (atv as any).playerState.clients.get('app').players.get('MediaRemote-DefaultPlayer');
    const stored = [...Object.values(player.direct), ...player.items.flatMap((item: any) => Object.values(item.metadata ?? {}))];
    expect(stored.filter(value => Buffer.isBuffer(value) && value.buffer === frame.buffer)).toEqual([]);
    expect(atv.nowPlaying.title).toBe('D');
  });
  it('uses the same snapshot for getNowPlaying and events', async () => {
    const atv = device();
    let emitted: unknown;
    atv.on('nowPlaying', (info) => { emitted = info; });
    let events = 0;
    atv.on('nowPlaying', () => { events++; });
    (atv as any).connection = { sendMRPMessageAndWait: async () => {
      const response = { type: 4, '.setStateMessage': { nowPlayingInfo: { title: 'Direct' }, playbackState: 3 } };
      (atv as any).handleMRPMessage(response);
      return response;
    } };
    const info = await (atv as any).getNowPlaying();
    expect(events).toBe(1);
    expect(info).toBe(emitted);
    expect(info.playbackState).toBe(PlaybackState.Stopped);
  });
  it('normalizes encoded queue metadata and direct identifiers into public event and cached snapshots', async () => {
    const atv = device();
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'app' } });
    Reflect.set(atv, 'connection', {});
    const root = protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace);
    const proto = root.lookupType('ProtocolMessage');
    let emitted: unknown;
    atv.on('nowPlaying', info => { emitted = info; });
    const bytes = proto.encode(proto.create({
      type: MessageType.SetState,
      '.setStateMessage': {
        playerPath: path('app'), playbackState: 1,
        nowPlayingInfo: { uniqueIdentifier: '9007199254740993', shuffleMode: 3, repeatMode: 2 },
        playbackQueue: { location: 0, contentItems: [{ identifier: 'current', metadata: {
          title: 'Episode', genre: 'Drama', contentIdentifier: 'content-id', seriesName: 'Series',
          seasonNumber: 0, episodeNumber: 0, mediaType: 2, mediaSubType: 4,
          iTunesStoreIdentifier: '9007199254740993', iTunesStoreSubscriptionIdentifier: '9007199254740994',
          iTunesStoreArtistIdentifier: '9007199254740995', iTunesStoreAlbumIdentifier: '9007199254740996',
        } }] },
      },
    })).finish();
    Reflect.get(atv, 'handleMRPMessage').call(atv, await MRPMessage.decode(Buffer.from(bytes)));
    expect(emitted).toBe(atv.nowPlaying);
    await expect(Reflect.get(atv, 'getNowPlaying').call(atv)).resolves.toBe(atv.nowPlaying);
    expect(atv.nowPlaying).toMatchObject({
      genre: 'Drama', contentIdentifier: 'content-id', seriesName: 'Series', seasonNumber: 0, episodeNumber: 0,
      mediaType: MediaType.Video, mediaSubType: MediaSubType.Podcast, uniqueIdentifier: '9007199254740993',
      iTunesStoreIdentifier: '9007199254740993', iTunesStoreSubscriptionIdentifier: '9007199254740994',
      iTunesStoreArtistIdentifier: '9007199254740995', iTunesStoreAlbumIdentifier: '9007199254740996',
    });
  });
  it('preserves direct playback evidence from encoded unnormalized fields without retaining them', async () => {
    const atv = device();
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'app' } });
    const root = protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace);
    const proto = root.lookupType('ProtocolMessage');
    const direct = proto.encode(proto.create({
      type: MessageType.SetState,
      '.setStateMessage': { playerPath: path('app'), nowPlayingInfo: { isAdvertisement: true } },
    })).finish();
    Reflect.get(atv, 'handleMRPMessage').call(atv, await MRPMessage.decode(Buffer.from(direct)));
    expect(atv.nowPlaying).toMatchObject({ hasPlayback: true, title: '' });
    const player = Reflect.get(Reflect.get(atv, 'playerState'), 'clients')
      .get('app').players.get('MediaRemote-DefaultPlayer');
    expect(player.direct).toEqual({});
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), playbackQueue: { contentItems: [] } });
    expect(atv.nowPlaying.hasPlayback).toBe(false);
  });
  it('keeps omitted metadata, clears replacements, and rejects unknown normalized enums', () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), playbackQueue: {
      location: 0, contentItems: [{ identifier: 'current', metadata: { seriesName: 'Series', mediaType: 1, seasonNumber: 0 } }],
    }, nowPlayingInfo: { shuffleMode: 0, repeatMode: 99 } });
    expect(atv.nowPlaying).toMatchObject({ seriesName: 'Series', seasonNumber: 0 });
    expect(atv.nowPlaying.mediaType).toBe(MediaType.Audio);
    expect(atv.nowPlaying.shuffleState).toBeUndefined();
    expect(atv.nowPlaying.repeatState).toBeUndefined();
    deliver(atv, MessageType.UpdateContentItem, 'updateContentItemMessage', { playerPath: path('app'),
      contentItems: [{ identifier: 'current', metadata: { episodeNumber: 0 } }] });
    expect(atv.nowPlaying).toMatchObject({ seriesName: 'Series', episodeNumber: 0 });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), playbackQueue: { contentItems: [] } });
    expect(atv.nowPlaying).toMatchObject({ seriesName: '', contentIdentifier: '', hasPlayback: false });
  });
});

describe('cache-first normalized state reads', () => {
  it.each([
    { playbackState: 1, nowPlayingInfo: { title: 'Pushed' } },
    { playbackState: 2, playbackQueue: { location: 0, contentItems: [{ identifier: 'x', metadata: { title: 'Paused' } }] } },
    { playbackState: 3, playbackQueue: { contentItems: [] } },
    { playbackQueue: { contentItems: [] } },
    { playbackState: 0 },
    { nowPlayingInfo: { title: 'State not reported' } },
  ])('returns received active-player state without a queue response: %j', async payload => {
    const atv = device();
    (atv as any).connection = {};
    const getState = vi.spyOn(atv, 'getState').mockRejectedValue(new Error('Queue must not be required'));
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'app' } });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), ...payload });
    const snapshot = atv.nowPlaying;
    await expect(atv.getNowPlaying()).resolves.toBe(snapshot);
    expect(getState).not.toHaveBeenCalled();
    if (!('playbackState' in payload)) expect(snapshot.playbackState).toBe(PlaybackState.Unknown);
    if (!('nowPlayingInfo' in payload) && !('playbackQueue' in payload)) expect(snapshot.hasPlayback).toBe(false);
  });

  it.each([
    [MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'app' } }],
    [MessageType.SetNowPlayingPlayer, 'setNowPlayingPlayerMessage', { playerPath: path('app') }],
    [MessageType.SetState, 'setStateMessage', { playerPath: path('app'), supportedCommands: { supportedCommands: [] } }],
    [MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: {} }],
  ] as const)('does not treat identity or commands as a received playback snapshot: %s', async (type, field, payload) => {
    const atv = device();
    (atv as any).connection = {};
    const error = new Error('Timeout waiting for MRP message type 4');
    const getState = vi.spyOn(atv, 'getState').mockRejectedValue(error);
    deliver(atv, type, field, payload);
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    expect(getState).toHaveBeenCalledOnce();
  });

  it('resolves nothing playing for an idle TV that selects the empty now-playing client', async () => {
    const atv = device();
    (atv as any).connection = {};
    const getState = vi.spyOn(atv, 'getState').mockResolvedValue({ type: 4, '.setStateMessage': {} });
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', {});
    await expect(atv.getNowPlaying()).resolves.toMatchObject({ hasPlayback: false, playbackState: PlaybackState.Unknown });
    expect(getState).not.toHaveBeenCalled();
  });

  it('requests a queue once the empty client selects a specific player with no state', async () => {
    const atv = device();
    (atv as any).connection = {};
    const error = new Error('Timeout waiting for MRP message type 4');
    const getState = vi.spyOn(atv, 'getState').mockRejectedValue(error);
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', {});
    deliver(atv, MessageType.SetNowPlayingPlayer, 'setNowPlayingPlayerMessage', { playerPath: { player: { identifier: 'p' } } });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    expect(getState).toHaveBeenCalledOnce();
  });

  it('does not bypass the queue for the first pushed player before any active routing selection', async () => {
    const atv = device();
    (atv as any).connection = {};
    const error = new Error('Timeout waiting for MRP message type 4');
    const getState = vi.spyOn(atv, 'getState').mockRejectedValue(error);
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('inactive'), nowPlayingInfo: { title: 'First push' } });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    expect(getState).toHaveBeenCalledOnce();
    deliver(atv, MessageType.SetNowPlayingPlayer, 'setNowPlayingPlayerMessage', { playerPath: path('other', 'selected') });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    getState.mockResolvedValue({ type: 4, '.setStateMessage': {} });
    await expect(atv.getNowPlaying()).rejects.toThrow('No active-player state received');
  });

  it('only uses state for the currently selected client/player', async () => {
    const atv = device();
    (atv as any).connection = {};
    const error = new Error('Timeout waiting for MRP message type 4');
    vi.spyOn(atv, 'getState').mockRejectedValue(error);
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'active' } });
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('inactive'), nowPlayingInfo: { title: 'Other app' } });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('active', 'other'), nowPlayingInfo: { title: 'Other player' } });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    deliver(atv, MessageType.SetNowPlayingPlayer, 'setNowPlayingPlayerMessage', { playerPath: path('active', 'other') });
    await expect(atv.getNowPlaying()).resolves.toMatchObject({ title: 'Other player' });
    deliver(atv, MessageType.RemovePlayer, 'removePlayerMessage', { playerPath: path('active', 'other') });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'inactive' } });
    await expect(atv.getNowPlaying()).resolves.toMatchObject({ title: 'Other app' });
    deliver(atv, MessageType.RemoveClient, 'removeClientMessage', { client: { bundleIdentifier: 'inactive' } });
    await expect(atv.getNowPlaying()).rejects.toBe(error);
  });

  it('keeps raw getState as a correlated queue request even with a cached snapshot', async () => {
    const atv = device();
    const raw = { type: 4, identifier: 'reply', '.setStateMessage': { playbackState: 2, nowPlayingInfo: { title: 'Raw' } } };
    (atv as any).connection = { sendMRPMessageAndWait: async (bytes: Buffer, type: number, timeout: number) => {
      const request = await MRPMessage.decode(bytes);
      expect(request.type).toBe(MessageType.PlaybackQueueRequest);
      expect(request['.playbackQueueRequestMessage']).toMatchObject({ location: 0, length: 1, includeMetadata: true });
      expect(type).toBe(MessageType.SetState);
      expect(timeout).toBe(10000);
      return raw;
    } };
    deliver(atv, MessageType.SetState, 'setStateMessage', { nowPlayingInfo: { title: 'Pushed' } });
    await expect(atv.getState()).resolves.toBe(raw);
  });

  it('accepts a queue-only SetState reply as active-player state', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => {
      const response = { type: 4, '.setStateMessage': { playbackQueue: { contentItems: [] } } };
      (atv as any).handleMRPMessage(response);
      return response;
    } };
    await expect(atv.getNowPlaying()).resolves.toMatchObject({ hasPlayback: false, playbackState: PlaybackState.Unknown });
  });

  it('does not report absent playback when a queue reply has no selected-player state', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => ({ type: 4, '.setStateMessage': {} }) };
    await expect(atv.getNowPlaying()).rejects.toThrow('No active-player state received');
  });

  it.each([
    ['without playerPath', { playbackState: 1 }],
    ['for another player', { playerPath: path('app', 'other'), playbackState: 1 }],
  ])('resolves the routed player snapshot when a valid queue reply arrives %s', async (_label, reply) => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => {
      const response = { type: 4, '.setStateMessage': reply };
      (atv as any).handleMRPMessage(response);
      return response;
    } };
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'app' } });
    await expect(atv.getNowPlaying()).resolves.toMatchObject({ hasPlayback: false, appBundleIdentifier: 'app' });
  });

  it('a decoded empty queue reply cannot validate an earlier unrouted push', async () => {
    const atv = device();
    // Wire type 4 with an empty SetStateMessage extension: no playbackState or playerPath on the wire.
    (atv as any).connection = { sendMRPMessageAndWait: async () => MRPMessage.decode(Buffer.from('08044a00', 'hex')) };
    deliver(atv, MessageType.SetState, 'setStateMessage', { nowPlayingInfo: { title: 'Stale push' } });
    await expect(atv.getNowPlaying()).rejects.toThrow('No active-player state received');
  });

  it('rejects disconnected reads even if public nowPlaying was retained by a caller', async () => {
    const atv = device();
    deliver(atv, MessageType.SetState, 'setStateMessage', { nowPlayingInfo: { title: 'Pushed' } });
    await expect(atv.getNowPlaying()).rejects.toThrow('Not connected');
  });

  it('does not hide a real queue timeout behind a push received while the request is pending', async () => {
    vi.useFakeTimers();
    const atv = device();
    const conn = new AirPlayConnection('offline', 7000, { clientId: 'test', serverId: 'test', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) });
    const send = vi.spyOn(conn, 'sendMRPMessage').mockImplementation(async () => {
      deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'app' } });
      deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('app'), nowPlayingInfo: { title: 'Unsolicited' } });
    });
    (atv as any).connection = conn;
    try {
      const rejection = expect(atv.getNowPlaying()).rejects.toThrow('Timeout waiting for MRP message type 4');
      await vi.advanceTimersByTimeAsync(10000);
      await rejection;
      await expect(atv.getNowPlaying()).resolves.toMatchObject({ title: 'Unsolicited' });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      await atv.close();
      vi.useRealTimers();
    }
  });
});

describe('runtime availability', () => {
  it('distinguishes unknown, supported, unavailable, and unsupported per active player', () => {
    const atv = device();
    expect((atv as any).featureAvailability('play')).toBe('unknown');
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('a'), supportedCommands: { supportedCommands: [{ command: 1, enabled: true }, { command: 2, enabled: false }] } });
    expect((atv as any).featureAvailability('play')).toBe('supported');
    expect((atv as any).featureAvailability('pause')).toBe('unavailable');
    expect((atv as any).featureAvailability('stop')).toBe('unsupported');
    deliver(atv, MessageType.SetState, 'setStateMessage', { playerPath: path('a'), nowPlayingInfo: { title: 'Unrelated' } });
    expect((atv as any).featureAvailability('play')).toBe('supported');
    deliver(atv, MessageType.SetNowPlayingClient, 'setNowPlayingClientMessage', { client: { bundleIdentifier: 'b' } });
    expect((atv as any).featureAvailability('play')).toBe('unknown');
  });
  it('treats omitted decoded volume advertisement fields as unknown', async () => {
    const atv = device();
    (atv as any).handleMRPMessage(await MRPMessage.decode(Buffer.from([8, 17, 178, 1, 0])));
    expect(atv.featureAvailability('setVolume')).toBe('unknown');
  });
  it('uses explicit volume capabilities, not device model or output identity', () => {
    const atv = device();
    deliver(atv, MessageType.DeviceInfo, 'deviceInfoMessage', { deviceUID: 'dev' });
    expect((atv as any).featureAvailability('setVolume')).toBe('unknown');
    deliver(atv, MessageType.VolumeControlAvailability, 'volumeControlAvailabilityMessage', { volumeControlAvailable: true, volumeCapabilities: 2 });
    expect((atv as any).featureAvailability('setVolume')).toBe('supported');
    deliver(atv, MessageType.VolumeControlAvailability, 'volumeControlAvailabilityMessage', { volumeControlAvailable: false });
    expect((atv as any).featureAvailability('setVolume')).toBe('unavailable');
    expect((atv as any).featureAvailability('up')).toBe('unknown');
  });
  it.each([
    // Family Room (AppleTV6,2, tvOS 26.6): available 0, capabilities 0.
    ['00', 'unavailable', 'unavailable'],
    // Master Bedroom (AppleTV5,3, tvOS 26.6): available 1, capabilities 1 (relative only).
    ['11', 'unsupported', 'supported'],
  ])('reads volume capabilities from the GetVolumeControlCapabilities result %s', async (bits, setVolume, volumeUp) => {
    const atv = device();
    deliver(atv, MessageType.DeviceInfo, 'deviceInfoMessage', { deviceUID: 'dev' });
    const wire = Buffer.from(`083f1202696d9a04060a04080${bits[0]}100${bits[1]}`, 'hex');
    (atv as any).handleMRPMessage(await MRPMessage.decode(wire));
    expect(atv.featureAvailability('setVolume')).toBe(setVolume);
    expect(atv.featureAvailability('volumeUp')).toBe(volumeUp);
  });
  it('keeps pushed volume capabilities when the handshake reply carries none', async () => {
    const atv = device();
    deliver(atv, MessageType.DeviceInfo, 'deviceInfoMessage', { deviceUID: 'dev' });
    deliver(atv, MessageType.VolumeControlAvailability, 'volumeControlAvailabilityMessage', { volumeControlAvailable: true, volumeCapabilities: 3 });
    // Bare type 63, then an errored type 63 (errorCode 1), both without extension 67.
    (atv as any).handleMRPMessage(await MRPMessage.decode(Buffer.from('083f1202696d', 'hex')));
    (atv as any).handleMRPMessage(await MRPMessage.decode(Buffer.from('083f1202696d1801', 'hex')));
    expect(atv.featureAvailability('setVolume')).toBe('supported');
  });
  it('applies VolumeControlCapabilitiesDidChange only for our output device', async () => {
    const atv = device();
    deliver(atv, MessageType.DeviceInfo, 'deviceInfoMessage', { deviceUID: 'dev' });
    deliver(atv, MessageType.VolumeControlAvailability, 'volumeControlAvailabilityMessage', { volumeControlAvailable: true, volumeCapabilities: 1 });
    // Type 64, extension 68: {capabilities: {available 1, capabilities 3}, outputDeviceUID}.
    const changed = (uid: string) => {
      const body = Buffer.concat([Buffer.from('0a0408011003', 'hex'), Buffer.from([0x22, uid.length]), Buffer.from(uid)]);
      return Buffer.concat([Buffer.from('0840a204', 'hex'), Buffer.from([body.length]), body]);
    };
    (atv as any).handleMRPMessage(await MRPMessage.decode(changed('other')));
    expect(atv.featureAvailability('setVolume')).toBe('unsupported');
    (atv as any).handleMRPMessage(await MRPMessage.decode(changed('dev')));
    expect(atv.featureAvailability('setVolume')).toBe('supported');
  });
});

it('rejects a wire-encoded envelope error despite inner success', async () => {
  const atv = device();
  // type 2; errorCode field 4 = 7; result extension 7 = sendError 0.
  const wire = Buffer.from([8, 2, 32, 7, 58, 2, 8, 0]);
  (atv as any).connection = { sendMRPMessageAndWait: () => MRPMessage.decode(wire) };
  await expect(atv.play()).rejects.toThrow('errorCode=7');
});


it('resolves nothing playing when the queue request is answered with error 35 (#10, Apple TV HD)', async () => {
  const atv = device();
  const connect = vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  const proto = protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace).lookupType('ProtocolMessage');
  const send = vi.spyOn(AirPlayConnection.prototype, 'sendMRPMessage').mockImplementation(async function (this: AirPlayConnection, bytes: Buffer) {
    const request = await MRPMessage.decode(bytes);
    const reply = proto.encode(proto.create({ identifier: request.identifier, errorCode: 35,
      errorDescription: 'Could not find the specified now playing client' })).finish();
    await (this as any).handleMRPResponse(Buffer.from(reply));
  });
  vi.useFakeTimers();
  try {
    await atv.connect(new Credentials({ clientId: 'test', serverId: 'test', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) }));
    const info = atv.getNowPlaying();
    await vi.advanceTimersByTimeAsync(0);
    await expect(info).resolves.toMatchObject({ hasPlayback: false, playbackState: PlaybackState.Unknown });
    // Other queue callers still see the device's rejection.
    const raw = expect(atv.getState()).rejects.toMatchObject({ errorCode: 35 });
    await vi.advanceTimersByTimeAsync(0);
    await raw;
  } finally {
    vi.useRealTimers();
    await atv.close();
    connect.mockRestore();
    send.mockRestore();
  }
});

it('normalizes through the real transport before getNowPlaying resolves', async () => {
  const atv = device();
  const connect = vi.spyOn(AirPlayConnection.prototype, 'connect').mockResolvedValue();
  const send = vi.spyOn(AirPlayConnection.prototype, 'sendMRPMessage').mockImplementation(async function (this: AirPlayConnection, bytes: Buffer) {
    const request = await MRPMessage.decode(bytes);
    const proto = protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace).lookupType('ProtocolMessage');
    const response = proto.encode(proto.create({ type: 4, identifier: request.identifier, '.setStateMessage': { nowPlayingInfo: { title: 'Transport song' }, playbackState: 2 } })).finish();
    await (this as any).handleMRPResponse(Buffer.from(response));
  });
  try {
    await atv.connect(new Credentials({ clientId: 'test', serverId: 'test', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) }));
    const events: string[] = [];
    atv.on('nowPlaying', info => { events.push(info.title); });
    const info = await atv.getNowPlaying();
    expect(events).toEqual(['Transport song']);
    expect(info).toBe(atv.nowPlaying);
    expect(info.playbackState).toBe(PlaybackState.Paused);
  } finally {
    await atv.close();
    connect.mockRestore();
    send.mockRestore();
  }
});
