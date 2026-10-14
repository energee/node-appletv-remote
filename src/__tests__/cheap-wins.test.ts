/**
 * Tests for the pyatv-parity additions: seek/shuffle/repeat, absolute volume, power state,
 * app list/launch, user accounts, extra Companion HID buttons and the playing app's bundle ID.
 * Wire formats follow pyatv (protocols/mrp/messages.py and protocols/companion/api.py).
 */
import { describe, it, expect, vi } from 'vitest';
import { AppleTV, Key, PowerState, RepeatState, ShuffleState, contentItems } from '../appletv.js';
import { MRPMessage, MessageType } from '../mrp/messages.js';
import { NowPlayingInfo } from '../now-playing-info.js';
import type { OpackDict, OpackValue } from '../companion/opack.js';

function makeAtv(): AppleTV {
  return new AppleTV({
    name: 'Test', address: '192.168.1.100', port: 7000, deviceId: 'AA:BB:CC', model: 'AppleTV6,2',
  });
}

/** Attach a fake MRP connection that decodes everything sent to it. */
function fakeMrp(atv: AppleTV) {
  const sent: Record<string, unknown>[] = [];
  (atv as any).connection = {
    sendMRPMessage: vi.fn(async (buf: Buffer) => { sent.push(await MRPMessage.decode(buf) as any); }),
  };
  return sent;
}

/** Attach a fake Companion connection that records requests and returns canned `_c` replies. */
function fakeCompanion(atv: AppleTV, reply: OpackDict = new Map()) {
  const requests: [string, OpackDict][] = [];
  const messages: [string, OpackDict][] = [];
  (atv as any).companionConnection = {
    sendRequest: vi.fn(async (id: string, content: OpackDict) => {
      requests.push([id, content]);
      return new Map<OpackValue, OpackValue>([['_t', 3], ['_c', reply]]);
    }),
    sendMessage: vi.fn((id: string, content: OpackDict) => { messages.push([id, content]); }),
  };
  return { requests, messages };
}

describe('MRP playback commands', () => {
  it('setPosition sends SeekToPlaybackPosition (45) with playbackPosition', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    await atv.setPosition(42);
    const cmd = sent[0]['.sendCommandMessage'] as any;
    expect(sent[0].type).toBe(MessageType.SendCommand);
    expect(cmd.command).toBe(45);
    expect(cmd.options.playbackPosition).toBe(42);
  });

  it('setShuffle sends ChangeShuffleMode (47) with shuffleMode', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    await atv.setShuffle(ShuffleState.Songs);
    const cmd = sent[0]['.sendCommandMessage'] as any;
    expect(cmd.command).toBe(47);
    expect(cmd.options.shuffleMode).toBe(3);
  });

  it('setRepeat sends ChangeRepeatMode (46) with repeatMode', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    await atv.setRepeat(RepeatState.Track);
    await atv.setRepeat(RepeatState.Off);
    const cmd = sent[0]['.sendCommandMessage'] as any;
    expect(cmd.command).toBe(46);
    // pyatv RepeatMode: Off 1, One 2, All 3
    expect(cmd.options.repeatMode).toBe(2);
    expect((sent[1]['.sendCommandMessage'] as any).options.repeatMode).toBe(1);
  });

  it('skipForward with an interval sends SkipForward (18) with skipInterval', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    await atv.skipForward(30);
    const cmd = sent[0]['.sendCommandMessage'] as any;
    expect(cmd.command).toBe(18);
    expect(cmd.options.skipInterval).toBe(30);
  });
});

describe('Volume', () => {
  it('setVolume sends SetVolumeMessage (51) for the output device as a 0..1 level', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    (atv as any).handleMRPMessage({
      type: MessageType.DeviceInfo, '.deviceInfoMessage': { deviceUID: 'dev-1', clusterID: '' },
    });
    await atv.setVolume(25);
    expect(sent[0].type).toBe(MessageType.SetVolume);
    const msg = sent[0]['.setVolumeMessage'] as any;
    expect(msg.outputDeviceUID).toBe('dev-1');
    expect(msg.volume).toBeCloseTo(0.25);
  });

  it('prefers clusterID over deviceUID as the output device', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    (atv as any).handleMRPMessage({
      type: MessageType.DeviceInfo, '.deviceInfoMessage': { deviceUID: 'dev-1', clusterID: 'cluster-1' },
    });
    await atv.setVolume(50);
    expect((sent[0]['.setVolumeMessage'] as any).outputDeviceUID).toBe('cluster-1');
  });

  it('setVolume rejects without an output device or out of range', async () => {
    const atv = makeAtv();
    fakeMrp(atv);
    await expect(atv.setVolume(10)).rejects.toThrow('output device');
    (atv as any).handleMRPMessage({ type: MessageType.DeviceInfo, '.deviceInfoMessage': { deviceUID: 'd' } });
    await expect(atv.setVolume(101)).rejects.toThrow('0..100');
  });

  it('VolumeDidChange for our device updates volume and emits a percentage', () => {
    const atv = makeAtv();
    const seen: number[] = [];
    atv.on('volume', (v: number) => seen.push(v));
    (atv as any).handleMRPMessage({ type: MessageType.DeviceInfo, '.deviceInfoMessage': { deviceUID: 'dev-1' } });
    (atv as any).handleMRPMessage({
      type: MessageType.VolumeDidChange, '.volumeDidChangeMessage': { volume: 0.5, outputDeviceUID: 'other' },
    });
    (atv as any).handleMRPMessage({
      type: MessageType.VolumeDidChange, '.volumeDidChangeMessage': { volume: 0.333, outputDeviceUID: 'dev-1' },
    });
    expect(seen).toEqual([33.3]);
    expect(atv.volume).toBe(33.3);
  });

  it('round-trips SetVolume through the bundled schema', async () => {
    const decoded = await MRPMessage.decode(await MRPMessage.setVolume('dev', 0.5)) as any;
    expect(decoded['.setVolumeMessage'].volume).toBe(0.5);
  });
});

describe('Companion apps, accounts and HID buttons', () => {
  it('appList sends FetchLaunchableApplicationsEvent and maps bundle IDs to names', async () => {
    const atv = makeAtv();
    const { requests } = fakeCompanion(atv, new Map([['com.netflix.Netflix', 'Netflix']]));
    const apps = await atv.appList();
    expect(requests[0][0]).toBe('FetchLaunchableApplicationsEvent');
    expect(apps).toEqual([{ name: 'Netflix', bundleId: 'com.netflix.Netflix' }]);
  });

  it('launchApp sends _bundleID for a bundle ID and _urlS for a URL', async () => {
    const atv = makeAtv();
    const { requests } = fakeCompanion(atv);
    await atv.launchApp('com.netflix.Netflix');
    await atv.launchApp('https://www.youtube.com/watch?v=x');
    expect(requests[0]).toEqual(['_launchApp', new Map([['_bundleID', 'com.netflix.Netflix']])]);
    expect(requests[1]).toEqual(['_launchApp', new Map([['_urlS', 'https://www.youtube.com/watch?v=x']])]);
  });

  it('accountList and switchAccount use the user-account events', async () => {
    const atv = makeAtv();
    const { requests } = fakeCompanion(atv, new Map([['acct-1', 'Alice']]));
    expect(await atv.accountList()).toEqual([{ name: 'Alice', id: 'acct-1' }]);
    await atv.switchAccount('acct-1');
    expect(requests[0][0]).toBe('FetchUserAccountsEvent');
    expect(requests[1]).toEqual(['SwitchUserAccountEvent', new Map([['SwitchAccountID', 'acct-1']])]);
  });

  it('companion buttons send _hidC down then up with the pyatv HID code', async () => {
    const atv = makeAtv();
    const { requests } = fakeCompanion(atv);
    await atv.channelUp();
    await atv.guide();
    expect(requests.map(([id, c]) => [id, c.get('_hBtS'), c.get('_hidC')])).toEqual([
      ['_hidC', 1, 15], ['_hidC', 2, 15],
      ['_hidC', 1, 17], ['_hidC', 2, 17],
    ]);
  });

  it('companion methods reject when Companion is not connected', async () => {
    const atv = makeAtv();
    await expect(atv.appList()).rejects.toThrow('Companion not connected');
    await expect(atv.screensaver()).rejects.toThrow('Companion not connected');
  });
});

describe('Power state', () => {
  it('fetchPowerState maps FetchAttentionState to on/off', async () => {
    const atv = makeAtv();
    fakeCompanion(atv, new Map([['state', 1]]));
    expect(await atv.fetchPowerState()).toBe(PowerState.Off);
    fakeCompanion(atv, new Map([['state', 3]]));
    expect(await atv.fetchPowerState()).toBe(PowerState.On);
    expect(atv.powerState).toBe(PowerState.On);
  });

  it('SystemStatus events update powerState and emit powerState on change only', () => {
    const atv = makeAtv();
    const seen: PowerState[] = [];
    atv.on('powerState', (s: PowerState) => seen.push(s));
    const event = (state: number) => ({
      identifier: 'SystemStatus',
      data: new Map<OpackValue, OpackValue>([['_c', new Map([['state', state]])]]),
    });
    (atv as any).handleCompanionEvent(event(2));
    (atv as any).handleCompanionEvent(event(3));
    (atv as any).handleCompanionEvent(event(1));
    expect(seen).toEqual([PowerState.On, PowerState.Off]);
  });

  it('subscribePowerState registers interest in both status events', () => {
    const atv = makeAtv();
    const { messages } = fakeCompanion(atv);
    atv.subscribePowerState();
    expect(messages[0][0]).toBe('_interest');
    expect(messages[0][1].get('_regEvents')).toEqual(['SystemStatus', 'TVSystemStatus']);
  });
});

describe('NowPlayingInfo app bundle ID', () => {
  it('reads the playing app bundle ID from playerPath.client', () => {
    const info = new NowPlayingInfo(
      { displayName: 'Netflix', playerPath: { client: { bundleIdentifier: 'com.netflix.Netflix' } } },
      { title: 'x' },
    );
    expect(info.appBundleIdentifier).toBe('com.netflix.Netflix');
  });
});

describe('sendKeyCommand routing', () => {
  it('routes skip keys to media commands and home_hold to a 1 s HID press', async () => {
    const atv = makeAtv();
    const sent = fakeMrp(atv);
    const sendKey = vi.spyOn(atv as any, 'sendKey').mockResolvedValue(undefined);
    await atv.sendKeyCommand(Key.SkipForward);
    await atv.sendKeyCommand(Key.HomeHold);
    await atv.sendKeyCommand(Key.Up);
    expect((sent[0]['.sendCommandMessage'] as any).command).toBe(18);
    expect(sendKey.mock.calls).toEqual([['home', 1000], ['up']]);
  });
});

describe('contentItems', () => {
  it('returns the playback queue items of a SetState reply, or [] when absent', () => {
    const item = { identifier: 'a' };
    expect(contentItems({ '.setStateMessage': { playbackQueue: { contentItems: [item] } } })).toEqual([item]);
    expect(contentItems({ '.setStateMessage': {} })).toEqual([]);
    expect(contentItems({})).toEqual([]);
  });
});
