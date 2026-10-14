/** Offline regression fixtures for MRP acknowledgments, player state, and availability. */
import { describe, it, expect } from 'vitest';
import protobuf from 'protobufjs';
import { MRP_SCHEMA } from '../mrp/schema.js';
import { AirPlayConnection } from '../connection.js';
import { Credentials } from '../credentials.js';
import { vi } from 'vitest';
import { AppleTV } from '../appletv.js';
import { PlaybackState } from '../now-playing-info.js';
import { MessageType, MRPMessage } from '../mrp/messages.js';

function device() {
  return new AppleTV({ name: 'Test', address: '127.0.0.1', port: 7000, deviceId: 'test', model: '' });
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
        expect(type).toBe(2);
        return { type: 2, '.sendCommandResultMessage': { sendError, handlerReturnStatus: 0 } };
      },
    };
    if (sendError === 0) await expect(atv.play()).resolves.toBeUndefined();
    else await expect(atv.play()).rejects.toThrow(`sendError=${sendError}`);
  });
  it('uses sendError rejection with handler diagnostics and rejects malformed acknowledgment', async () => {
    const atv = device();
    let payload: object = { handlerReturnStatus: 2, sendError: 8 };
    (atv as any).connection = { sendMRPMessage: async () => {}, sendMRPMessageAndWait: async () => ({ '.sendCommandResultMessage': payload }) };
    await expect(atv.pause()).rejects.toThrow('handlerReturnStatus=2');
    payload = {};
    await expect(atv.pause()).rejects.toThrow('Malformed');
  });
  it('rejects a decoded acknowledgment without an explicit status', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => MRPMessage.decode(Buffer.from([8, 2, 58, 0])) };
    await expect(atv.play()).rejects.toThrow('Malformed');
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
});

describe('cache-first normalized state reads', () => {
  it.each([
    { playbackState: 1, nowPlayingInfo: { title: 'Pushed' } },
    { playbackState: 2, playbackQueue: { location: 0, contentItems: [{ identifier: 'x', metadata: { title: 'Paused' } }] } },
    { playbackState: 3, playbackQueue: { contentItems: [] } },
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

  it('does not report absent playback when a queue reply has no selected-player state', async () => {
    const atv = device();
    (atv as any).connection = { sendMRPMessageAndWait: async () => ({ type: 4, '.setStateMessage': {} }) };
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
});

it('rejects a wire-encoded envelope error despite inner success', async () => {
  const atv = device();
  // type 2; errorCode field 4 = 7; result extension 7 = sendError 0.
  const wire = Buffer.from([8, 2, 32, 7, 58, 2, 8, 0]);
  (atv as any).connection = { sendMRPMessageAndWait: () => MRPMessage.decode(wire) };
  await expect(atv.play()).rejects.toThrow('errorCode=7');
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
