/** Routing decisions, no-replay errors and provider lifecycle, independent of physical hardware. */
import type { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSession } from '../session.js';
import { MRPMessage, MessageType } from '../mrp/messages.js';
import { Key, PowerState } from '../appletv.js';
import type { DiscoveredDeviceInfo } from '../discovery.js';
import type { OpackDict, OpackValue } from '../companion/opack.js';

const state = vi.hoisted(() => ({
  mrp: [] as Array<EventEmitter & { bytes: Buffer[]; close: () => void }>,
  companion: [] as Array<EventEmitter & { requests: Array<[string, OpackDict]>; close: () => void }>,
  failMRP: false, failCompanion: false, failAfterCompanionState: false, rejectCommand: false,
  pauseMRP: undefined as undefined | (() => Promise<void>),
}));
// Mock factories run before static imports initialize; dynamic imports intentionally establish this transport-module boundary.
vi.mock('../connection.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { AirPlayConnection: class extends EventEmitter {
    bytes: Buffer[] = [];
    constructor() { super(); state.mrp.push(this); }
    async connect() { if (state.pauseMRP) await state.pauseMRP(); if (state.failMRP) throw new Error('MRP authentication rejected'); }
    close = vi.fn(() => { this.emit('close'); });
    async sendMRPMessage(bytes: Buffer) { this.bytes.push(bytes); }
    async sendMRPMessageAndWait(bytes: Buffer) {
      this.bytes.push(bytes);
      if (state.rejectCommand) throw new Error('Sent command timed out');
      return { '.sendCommandResultMessage': { sendError: 0 } };
    }
  } };
});
vi.mock('../mrp/legacy-connection.js', async () => {
  const { AirPlayConnection } = await import('../connection.js');
  return { LegacyMRPConnection: AirPlayConnection };
});
vi.mock('../companion/connection.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { CompanionConnection: class extends EventEmitter {
    requests: Array<[string, OpackDict]> = [];
    constructor() { super(); state.companion.push(this); }
    async connect() { if (state.failCompanion) throw new Error('Companion authentication rejected'); }
    close = vi.fn(() => { this.emit('close'); });
    async sendRequest(identifier: string, content: OpackDict) {
      this.requests.push([identifier, content]);
      if (state.failAfterCompanionState && identifier === '_systemInfo') {
        this.emit('event', { identifier: 'SystemStatus', data: new Map<OpackValue, OpackValue>([['_c', new Map([['state', 3]])]]) });
        throw new Error('Companion setup lost after state');
      }
      const reply: OpackDict = new Map();
      if (identifier === '_sessionStart') reply.set('_sid', 42);
      return new Map<OpackValue, OpackValue>([['_c', reply]]);
    }
    sendMessage(identifier: string, content: OpackDict) { this.requests.push([identifier, content]); }
  } };
});

const device: DiscoveredDeviceInfo = {
  name: 'Synthetic', address: '127.0.0.1', deviceId: 'synthetic', model: 'AppleTV6,2',
  port: 7000, mrpPort: 49152, companionPort: 49153,
};
const keys = { clientId: 'controller', serverId: 'receiver', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) };
const credentials = { airplay: keys, mrp: keys, companion: keys };

beforeEach(() => {
  state.mrp.length = 0; state.companion.length = 0;
  state.failMRP = state.failCompanion = state.failAfterCompanionState = state.rejectCommand = false;
  state.pauseMRP = undefined;
});

describe('operation policy', () => {
  it('prefers MRP media and MRP power in a mixed session', async () => {
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys } });
    await session.connect();
    try {
      await session.execute('play');
      expect((await MRPMessage.decode(state.mrp[0].bytes[0])).type).toBe(MessageType.SendCommand);
      await session.execute('wake');
      const hid = state.companion[0].requests.filter(([id]) => id === '_hidC');
      expect(hid.map(([, content]) => [content.get('_hidC'), content.get('_hBtS')])).toEqual([[13, 1], [13, 2]]);
      expect(state.mrp[0].bytes).toHaveLength(1);
      expect(session.powerState).toBe(PowerState.Unknown);
      // A sleeping Apple TV rejects Companion power requests but MRP still reports logicalDeviceCount 0.
      state.mrp[0].emit('mrp-message', { type: MessageType.DeviceInfo, '.deviceInfoMessage': { logicalDeviceCount: 0 } });
      state.companion[0].emit('event', { identifier: 'SystemStatus', data: new Map<OpackValue, OpackValue>([['_c', new Map([['state', 3]])]]) });
      expect(session.powerState).toBe(PowerState.Off);
      await expect(session.execute('fetchPowerState')).resolves.toBe(PowerState.Off);
    } finally { await session.close(); }
  });

  it('uses strict per-operation override and emits only its volume provider', async () => {
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys }, preferences: { play: 'companion', setVolume: 'companion' } });
    const volumes: number[] = [];
    session.on('volume', value => volumes.push(value));
    await session.connect();
    try {
      await session.execute('play');
      expect(state.mrp[0].bytes).toEqual([]);
      expect(state.companion[0].requests.filter(([id]) => id === '_mcc').map(([, content]) => content.get('_mcc'))).toContain(1);
      // MRP volume is valid protocol evidence, but not the selected normalized provider.
      state.mrp[0].emit('mrp-message', { type: MessageType.DeviceInfo, '.deviceInfoMessage': { deviceUID: 'speaker' } });
      state.mrp[0].emit('mrp-message', { type: MessageType.VolumeDidChange, '.volumeDidChangeMessage': { outputDeviceUID: 'speaker', volume: 0.5 } });
      expect(volumes).toEqual([]);
    } finally { await session.close(); }
  });

  it('retains observed volume when its source does not permit absolute volume control', async () => {
    const session = new DeviceSession(device, { credentials: { airplay: keys } });
    const volumes: unknown[] = [];
    session.on('volume', value => volumes.push(value));
    await session.connect();
    try {
      state.mrp[0].emit('mrp-message', { type: MessageType.DeviceInfo, '.deviceInfoMessage': { deviceUID: 'speaker' } });
      state.mrp[0].emit('mrp-message', { type: MessageType.VolumeControlAvailability, '.volumeControlAvailabilityMessage': { volumeControlAvailable: false } });
      state.mrp[0].emit('mrp-message', { type: MessageType.VolumeDidChange, '.volumeDidChangeMessage': { outputDeviceUID: 'speaker', volume: 0.5 } });
      expect(session.featureAvailability('setVolume')).toBe('unavailable');
      expect(session.volume).toBe(50);
      expect(volumes).toEqual([50]);
    } finally { await session.close(); }
  });

  it('excludes advertised unsupported media before sending, but never replays a timeout', async () => {
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys } });
    await session.connect();
    try {
      state.rejectCommand = true;
      const prior = state.companion[0].requests.length;
      await expect(session.execute('play')).rejects.toThrow('Sent command timed out');
      expect(state.mrp[0].bytes).toHaveLength(1);
      expect(state.companion[0].requests).toHaveLength(prior);
      state.rejectCommand = false;
      state.mrp[0].emit('mrp-message', { type: MessageType.SetState, '.setStateMessage': { supportedCommands: { supportedCommands: [] } } });
      await session.execute('play');
      expect(state.mrp[0].bytes).toHaveLength(1);
      expect(state.companion[0].requests.filter(([id]) => id === '_mcc').map(([, content]) => content.get('_mcc'))).toContain(1);
    } finally { await session.close(); }
  });

  it('keeps unsupported and unavailable distinct and never falls back from an override', async () => {
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys }, preferences: { play: 'airplay' } });
    await session.connect();
    try {
      expect(session.featureAvailability('play')).toBe('unknown');
      state.mrp[0].emit('mrp-message', { type: MessageType.SetState, '.setStateMessage': { supportedCommands: { supportedCommands: [] } } });
      expect(session.featureAvailability('play')).toBe('unsupported');
      await expect(session.execute('play')).rejects.toThrow('No usable control transport');
      state.mrp[0].emit('close');
      expect(session.featureAvailability('play')).toBe('unavailable');
      expect(state.companion[0].requests.some(([id]) => id === '_mcc')).toBe(false);
    } finally { await session.close(); }
  });

  it('opens only the requested operation provider and supports Companion-only key dispatch', async () => {
    const session = new DeviceSession(device, { credentials, operations: ['wake'] });
    await session.connect();
    try {
      expect(state.mrp).toEqual([]);
      await session.sendKeyCommand(Key.Wake);
      expect(state.companion[0].requests.filter(([id]) => id === '_hidC').map(([, c]) => c.get('_hidC'))).toEqual([13, 13]);
      expect(session.featureAvailability('stop')).toBe('unsupported');
      await expect(session.execute('stop')).rejects.toThrow('No usable control transport');
    } finally { await session.close(); }
  });

  it('rejects missing credentials, legacy AirPlay tunnels and unsupported overrides before sockets', () => {
    expect(() => new DeviceSession(device, { credentials: {}, transports: { airplay: {} } })).toThrow('Missing airplay credentials');
    expect(() => new DeviceSession({ ...device, model: 'AppleTV3,2' }, { credentials: { airplay: keys }, transports: { airplay: {} } })).toThrow('No eligible airplay endpoint');
    expect(() => new DeviceSession(device, { credentials, preferences: { requestArtwork: 'companion' } })).toThrow('not implemented');
    expect(state.mrp).toEqual([]); expect(state.companion).toEqual([]);
  });
});

describe('setup, loss and teardown', () => {
  it('required partial failure closes all opened providers exactly once', async () => {
    state.failCompanion = true;
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys } });
    await expect(session.connect()).rejects.toThrow('Companion authentication rejected');
    expect(state.mrp[0].close).toHaveBeenCalledTimes(1);
    expect(state.companion[0].close).toHaveBeenCalledTimes(1);
    await expect(session.execute('play')).rejects.toThrow('not ready');
  });

  it('reports optional failure without claiming its feature is available', async () => {
    state.failCompanion = true;
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys }, transports: { airplay: {}, companion: { required: false } } });
    const connections: Array<{ protocol: string; state: string }> = [];
    session.on('connection', event => connections.push(event));
    await session.connect();
    try {
      expect(connections.map(event => [event.protocol, event.state])).toEqual([['airplay', 'ready'], ['companion', 'failed']]);
      expect(session.featureAvailability('appList')).toBe('unavailable');
      await session.execute('play');
      expect(state.mrp[0].bytes).toHaveLength(1);
    } finally { await session.close(); }
  });

  it('does not publish unready optional-provider state when setup fails', async () => {
    state.failAfterCompanionState = true;
    // Power defaults to MRP; pin it to Companion so the unready Companion provider is what is under test.
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys },
      transports: { airplay: {}, companion: { required: false } }, preferences: { fetchPowerState: 'companion' } });
    const powers: PowerState[] = [];
    session.on('powerState', power => powers.push(power));
    await session.connect();
    try {
      expect(powers).toEqual([]);
      expect(session.powerState).toBe(PowerState.Unknown);
      expect(session.featureAvailability('fetchPowerState')).toBe('unavailable');
    } finally { await session.close(); }
  });

  it('close during setup prevents late readiness and rejects concurrent setup', async () => {
    let release!: () => void;
    state.pauseMRP = () => new Promise<void>(resolve => { release = resolve; });
    const session = new DeviceSession(device, { credentials: { airplay: keys } });
    const ready = vi.fn(); session.on('ready', ready);
    const setup = session.connect();
    await expect(session.connect()).rejects.toThrow('connecting');
    await session.close();
    release();
    await expect(setup).rejects.toThrow('closed during setup');
    expect(ready).not.toHaveBeenCalled();
    expect(state.mrp[0].close).toHaveBeenCalledTimes(1);
  });

  it('invalidates lost state and ignores stale events while later calls use an already-ready provider', async () => {
    const session = new DeviceSession(device, { credentials: { airplay: keys, companion: keys } });
    const titles: string[] = [];
    session.on('nowPlaying', value => titles.push(value.title));
    await session.connect();
    state.mrp[0].emit('mrp-message', { type: MessageType.SetState, '.setStateMessage': { nowPlayingInfo: { title: 'Live' } } });
    expect(session.nowPlaying.title).toBe('Live');
    state.mrp[0].emit('close');
    expect(session.nowPlaying.title).toBe('');
    state.mrp[0].emit('mrp-message', { type: MessageType.SetState, '.setStateMessage': { nowPlayingInfo: { title: 'Stale' } } });
    await session.execute('play');
    expect(titles).toEqual(['Live', '']);
    await session.close(); await session.close();
    expect(state.companion[0].close).toHaveBeenCalledTimes(1);
  });
});
