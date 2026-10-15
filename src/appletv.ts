/**
 * High-level Apple TV client. Wraps an AirPlay/MRP connection (remote keys,
 * media commands, text input, now-playing state) and an optional Companion
 * connection (apps, accounts, extra buttons, power state) behind one EventEmitter.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PairSetup } from './auth/pair-setup.js';
import { AirPlayConnection } from './connection.js';
import { LegacyMRPConnection } from './mrp/legacy-connection.js';
import type { MRPConnection } from './mrp/connection.js';
import { Credentials } from './credentials.js';
import { MRPMessage, HID_KEY_MAP, MessageType } from './mrp/messages.js';
import { NowPlayingInfo } from './now-playing-info.js';
import { PlayerState } from './mrp/player-state.js';
import { Command, SupportedCommand } from './supported-command.js';
import { Message } from './message.js';
import { CompanionConnection } from './companion/connection.js';
import { CompanionPairSetup } from './companion/pair-setup.js';
import type { OpackDict, OpackValue } from './companion/opack.js';
import type { HAPCredentials } from './auth/types.js';
import type { DiscoveredDeviceInfo } from './discovery.js';

/** Keyboard focus state from an MRP KeyboardMessage, emitted as `keyboard`. */
export interface KeyboardInfo {
  /** True when a text field is focused (KeyboardMessage state 1). */
  focused: boolean;
  title?: string;
  prompt?: string;
  inputTraits?: Record<string, unknown>;
}

/** Text change from an MRP TextInputMessage, emitted as `textInput`. */
export interface TextInputEvent {
  text?: string;
  /** A TextInputActionType value. */
  actionType?: number;
  timestamp?: number;
}

/** MRP TextInputMessage action types used by setText/insertText/clearText/deleteText. */
export enum TextInputActionType {
  Unknown = 0,
  Insert = 1,
  Set = 2,
  Delete = 3,
  ClearText = 4,
}

/** Runtime evidence, not a promise that a command will succeed. */
export type FeatureAvailability = 'supported' | 'unavailable' | 'unsupported' | 'unknown';
/** Public method names; capabilities without runtime advertisements remain unknown. */
export type Feature = 'play' | 'pause' | 'stop' | 'next' | 'previous' | 'setPosition' | 'setShuffle' | 'setRepeat' | 'skipForward' | 'skipBackward' | 'setVolume' | 'volumeUp' | 'volumeDown' | 'up' | 'down' | 'left' | 'right' | 'select' | 'menu' | 'home' | 'playPause' | 'wake' | 'suspend' | 'setText' | 'appList' | 'launchApp' | 'accountList' | 'switchAccount' | 'getState' | 'requestArtwork';

/** Options for AppleTV.connect(). */
export interface ConnectOptions {
  /**
   * Pause after the MRP handshake before connect() resolves, in ms; default 0.
   * Raise it (e.g. 500) if a command sent right after connecting is ignored.
   */
  settleMs?: number;
}

/**
 * Buttons accepted by sendKeyCommand(). Values are HID_KEY_MAP names; keys without
 * a HID mapping (play, pause, next, previous, skip, wake, suspend, home_hold) are
 * routed to their dedicated methods instead.
 */
export enum Key {
  Up = 'up',
  Down = 'down',
  Left = 'left',
  Right = 'right',
  Select = 'select',
  Menu = 'menu',
  Home = 'home',
  HomeHold = 'home_hold',
  TopMenu = 'top_menu',
  PlayPause = 'play_pause',
  Play = 'play',
  Pause = 'pause',
  Next = 'next',
  Previous = 'previous',
  SkipForward = 'skip_forward',
  SkipBackward = 'skip_backward',
  VolumeUp = 'volume_up',
  VolumeDown = 'volume_down',
  Suspend = 'suspend',
  Wake = 'wake',
}

/** Shuffle modes for setShuffle; values are the MRP CommandOptions.ShuffleMode enum. */
export enum ShuffleState {
  Off = 1,
  Albums = 2,
  Songs = 3,
}

/** Repeat modes for setRepeat; values are the MRP CommandOptions.RepeatMode enum. */
export enum RepeatState {
  Off = 1,
  Track = 2,
  All = 3,
}

/** Device power as reported by Companion SystemStatus (pyatv PowerState). */
export enum PowerState {
  Unknown = 'unknown',
  Off = 'off',
  On = 'on',
}

/** Button action timing: tap retains existing defaults; hold lasts one second. */
export type InputAction = 'singleTap' | 'doubleTap' | 'hold';
/** Companion touch phase values from pyatv 0.18.0. */
export enum TouchAction { Press = 1, Hold = 3, Release = 4, Click = 5 }
/** A currently selected output, not a discovered/available AirPlay receiver. */
export interface OutputDevice { name: string; identifier: string }

/** Reject invalid actions before any input is sent. */
function validateAction(action: InputAction): void {
  if (!['singleTap', 'doubleTap', 'hold'].includes(action)) throw new Error(`Unsupported input action: ${action}`);
}
/** Touch coordinates are integral device units, inclusive 0..1000. */
function validateCoordinates(...coordinates: number[]): void {
  if (coordinates.some(n => !Number.isInteger(n) || n < 0 || n > 1000)) {
    throw new RangeError('Touch coordinates must be integers in 0..1000');
  }
}

/** A launchable app from appList(). */
export interface App {
  name: string;
  bundleId: string;
}

/** A user account from accountList(). */
export interface UserAccount {
  name: string;
  id: string;
}

/** Companion `_hidC` button codes (pyatv HidCommand) for buttons MRP has no HID usage for. */
const COMPANION_HID = {
  screensaver: 11,
  channelUp: 15,
  channelDown: 16,
  guide: 17,
  pageUp: 18,
  pageDown: 19,
} as const;

/** Companion SystemStatus `state`: 1 asleep, 2 screensaver, 3 awake, 4 idle. */
function powerStateFromStatus(state: unknown): PowerState {
  if (state === 1) return PowerState.Off;
  if (state === 2 || state === 3 || state === 4) return PowerState.On;
  return PowerState.Unknown;
}

/** The `contentItems` of a SetState reply from requestPlaybackQueue/getState (empty if none). */
export function contentItems(response: Record<string, unknown>): Record<string, unknown>[] {
  const setState = response['.setStateMessage'] as { playbackQueue?: { contentItems?: unknown } } | undefined;
  const items = setState?.playbackQueue?.contentItems;
  return Array.isArray(items) ? items : [];
}

/** An unsolicited Companion event, re-emitted as `companionEvent`. */
export interface CompanionEvent {
  /** Event name (the `_i` field), e.g. `SystemStatus`. */
  identifier: string | undefined;
  /** The full decoded event dict; payload content is under `_c`. */
  data: OpackDict;
}

/**
 * Client for one Apple TV. Call connect() for MRP features and connectCompanion()
 * for Companion features; methods throw if their connection is not open.
 *
 * Events: `connect`, `close`, `error`, `message`, `nowPlaying`, `supportedCommands`,
 * `playbackQueue`, `featureAvailability`, `keyboard`, `textInput`, `volume`, `powerState`, `companionConnect`,
 * `companionClose`, `companionError`, `companionEvent`, `outputDevices`.
 * `close`/`companionClose` fire only after the matching connect event; failed setup only rejects.
 */
export class AppleTV extends EventEmitter {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly deviceId: string;
  readonly model: string;
  readonly companionPort?: number;
  readonly mrpPort?: number;
  readonly mrpEnabled?: boolean;
  readonly companionAddress: string;
  readonly mrpAddress: string;
  private connection?: MRPConnection;
  private airPlayErrorSource?: MRPConnection;
  private playerState = new PlayerState();
  private volumeAvailability?: Record<string, unknown>;
  /** Last normalized active-player snapshot; also emitted as nowPlaying. */
  nowPlaying = new NowPlayingInfo({ hasPlayback: false }, {});

  /** Advertised command: missing = unsupported, disabled = temporarily unavailable. */
  featureAvailability(feature: Feature): FeatureAvailability {
    const commands: Partial<Record<Feature, Command>> = {
      play: Command.Play, pause: Command.Pause, stop: Command.Stop,
      next: Command.NextTrack, previous: Command.PreviousTrack,
      skipForward: Command.SkipForward, skipBackward: Command.SkipBackward,
      setPosition: Command.SeekToPlaybackPosition, setRepeat: Command.ChangeRepeatMode,
      setShuffle: Command.ChangeShuffleMode,
    };
    const id = commands[feature];
    if (id !== undefined) {
      const advertised = this.playerState.commands;
      if (!advertised) return 'unknown';
      const command = advertised.find(cmd => cmd.command === id);
      return !command ? 'unsupported' : command.enabled ? 'supported' : 'unavailable';
    }
    if (feature === 'setVolume' || feature === 'volumeUp' || feature === 'volumeDown') {
      const volume = this.volumeAvailability;
      if (typeof volume?.volumeControlAvailable !== 'boolean') return 'unknown';
      if (!volume.volumeControlAvailable) return 'unavailable';
      if (typeof volume.volumeCapabilities !== 'number') return 'unknown';
      const supported = feature === 'setVolume' ? [2, 3] : [1, 3];
      if (!supported.includes(volume.volumeCapabilities)) return 'unsupported';
      return this.outputDeviceUID ? 'supported' : 'unavailable';
    }
    return 'unknown';
  }
  private companionConnection?: CompanionConnection;
  private companionErrorSource?: CompanionConnection;
  /** Output device for SetVolume, from the Apple TV's DeviceInfo reply (clusterID or deviceUID). */
  private outputDeviceUID?: string;
  private reportedOutputs: OutputDevice[] = [];
  /** Transports that emitted connect/companionConnect; only these report close events. */
  private readyTransports = new WeakSet<object>();
  /** Identifier of the reporting device when it leads the group; not a routable output in `set`. */
  private reportedLeader?: string;
  private pendingRouting?: { identifier: string; check: () => void; reject: (error: Error) => void };
  private touchSession?: { connection: CompanionConnection; sid: bigint; timestamp: bigint };
  private touchStarting?: Promise<void>;
  private activeTouch?: { x: number; y: number };
  private gestureController?: AbortController;
  private gestureBusy = false;
  /** Last absolute volume (0..100) reported by VolumeDidChange; undefined until one arrives. */
  volume?: number;
  /** Last power state from fetchPowerState() or a SystemStatus event. */
  powerState: PowerState = PowerState.Unknown;

  constructor(info: DiscoveredDeviceInfo) {
    super();
    this.name = info.name;
    this.address = info.address;
    this.port = info.port;
    this.deviceId = info.deviceId;
    this.model = info.model;
    this.companionPort = info.companionPort;
    this.mrpPort = info.mrpPort;
    this.mrpEnabled = info.mrpEnabled;
    this.companionAddress = info.companionAddress ?? info.address;
    this.mrpAddress = info.mrpAddress ?? info.address;
  }

  /** Pair AirPlay when advertised, otherwise enabled standalone MRP; credentials are transport-specific. */
  async startPairing(): Promise<PairSetup> {
    if (!this.port && this.mrpPort && this.mrpEnabled !== false) {
      const placeholder = { clientId: '', clientLTSK: Buffer.alloc(0), clientLTPK: Buffer.alloc(0), serverLTPK: Buffer.alloc(0), serverId: '' };
      return new LegacyMRPConnection(this.mrpAddress, this.mrpPort, placeholder).startPairing();
    }
    if (!this.port) throw new Error('No MRP transport available; use DmapPairing for DMAP or Companion pairing');
    const ps = new PairSetup(this.address, this.port);
    await ps.start();
    return ps;
  }

  /** Open advertised AirPlay or enabled standalone MRP; reject duplicate/failed setup and emit connect only once ready. */
  async connect(credentials: Credentials, options: ConnectOptions = {}): Promise<void> {
    if (this.connection) throw new Error('AirPlay already connected');
    this.resetRuntimeState();
    if (!this.port && !(this.mrpPort && this.mrpEnabled !== false)) throw new Error('No MRP transport available; use connectCompanion');
    const connection = this.connection = this.port
      ? new AirPlayConnection(this.address, this.port, credentials, options.settleMs)
      : new LegacyMRPConnection(this.mrpAddress, this.mrpPort!, credentials, options.settleMs);
    this.airPlayErrorSource = connection;
    connection.on('close', () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      this.pendingRouting?.reject(new Error('Connection closed'));
      this.reportedOutputs = [];
      this.reportedLeader = undefined;
      this.resetRuntimeState();
      // A failed setup reports through connect()'s rejection, never as `close`.
      if (this.readyTransports.has(connection)) this.emit('close');
    });
    connection.on('error', (err) => { if (this.airPlayErrorSource === connection && this.listenerCount('error')) this.emit('error', err); });
    connection.on('mrp-message', (msg: Record<string, unknown>) => {
      if (this.connection !== connection) return;
      this.handleMRPMessage(msg);
    });

    try {
      await connection.connect();
      if (this.connection !== connection) throw new Error('Connection closed during setup');
      this.readyTransports.add(connection);
      this.emit('connect');
    } catch (err) {
      connection.close();
      if (this.connection === connection) this.connection = undefined;
      throw err;
    }
  }

  /**
   * Cancel gestures, attempt touch cleanup, then close both transports even if cleanup fails.
   * A touch startup still in flight is abandoned (closing Companion ends it), not awaited.
   */
  async close(): Promise<void> {
    this.gestureController?.abort();
    try {
      if (!this.touchStarting) await this.stopTouch();
    } finally {
      const companion = this.companionConnection;
      const connection = this.connection;
      // Invalidate forwarding before low-level close emits synchronous lifecycle events.
      this.companionConnection = undefined;
      this.connection = undefined;
      this.companionErrorSource = undefined;
      this.airPlayErrorSource = undefined;
      this.touchSession = undefined;
      this.activeTouch = undefined;
      this.pendingRouting?.reject(new Error('Connection closed'));
      companion?.close();
      connection?.close();
      this.reportedOutputs = [];
      this.reportedLeader = undefined;
      this.resetRuntimeState();
      if (companion && this.readyTransports.has(companion)) this.emit('companionClose');
      if (connection && this.readyTransports.has(connection)) this.emit('close');
    }
  }

  // --- Companion protocol ---

  /**
   * Begin Companion pair-setup; the Apple TV shows a PIN to pass to the returned CompanionPairSetup.
   * @throws If no Companion port was given or discovered.
   */
  async startCompanionPairing(options?: { companionPort?: number }): Promise<CompanionPairSetup> {
    const port = options?.companionPort ?? this.companionPort;
    if (!port) throw new Error('No companion port available');
    const ps = new CompanionPairSetup(this.companionAddress, port);
    await ps.start();
    return ps;
  }

  /**
   * Open the Companion connection; emits `companionConnect` once ready.
   * @throws If no Companion port was given or discovered.
   */
  async connectCompanion(credentials: HAPCredentials, companionPort?: number): Promise<void> {
    if (this.companionConnection) throw new Error('Companion already connected');
    const port = companionPort ?? this.companionPort;
    if (!port) throw new Error('No companion port available');

    const connection = this.companionConnection = new CompanionConnection(this.companionAddress, port, credentials);
    this.companionErrorSource = connection;
    connection.on('close', () => {
      if (this.companionConnection !== connection) return;
      this.gestureController?.abort();
      this.touchSession = undefined;
      this.activeTouch = undefined;
      this.companionConnection = undefined;
      if (this.readyTransports.has(connection)) this.emit('companionClose');
    });
    connection.on('error', (err) => { if (this.companionErrorSource === connection) this.emit('companionError', err); });
    connection.on('event', (event: CompanionEvent) => {
      if (this.companionConnection !== connection) return;
      this.handleCompanionEvent(event);
    });

    try {
      await connection.connect();
      if (this.companionConnection !== connection) throw new Error('Companion closed during setup');
      this.readyTransports.add(connection);
      this.emit('companionConnect');
    } catch (err) {
      connection.close();
      if (this.companionConnection === connection) this.companionConnection = undefined;
      throw err;
    }
  }

  /** Send a raw Companion request and resolve with the device's reply. */
  async sendCompanionRequest(
    identifier: string,
    content: OpackDict,
    timeoutMs?: number,
  ): Promise<OpackDict> {
    return this.requireCompanion().sendRequest(identifier, content, timeoutMs);
  }

  /** Send a raw Companion message without waiting for a reply. */
  sendCompanionMessage(identifier: string, content: OpackDict): void {
    this.requireCompanion().sendMessage(identifier, content);
  }

  // --- Companion apps, accounts and buttons ---

  /** List launchable apps (Companion FetchLaunchableApplicationsEvent). */
  async appList(): Promise<App[]> {
    const content = await this.companionContent('FetchLaunchableApplicationsEvent');
    return [...content].map(([bundleId, name]) => ({ name: String(name), bundleId: String(bundleId) }));
  }

  /** Launch an app by bundle ID (`com.netflix.Netflix`) or open a URL / URL scheme. */
  async launchApp(bundleIdOrUrl: string): Promise<void> {
    // ponytail: pyatv's rule — anything with a URL scheme is a URL.
    const key = /^[a-z][a-z0-9+.-]*:/i.test(bundleIdOrUrl) ? '_urlS' : '_bundleID';
    await this.requireCompanion().sendRequest('_launchApp', new Map([[key, bundleIdOrUrl]]));
  }

  /** List user accounts that can be switched to (Companion FetchUserAccountsEvent). */
  async accountList(): Promise<UserAccount[]> {
    const content = await this.companionContent('FetchUserAccountsEvent');
    return [...content].map(([id, name]) => ({ name: String(name), id: String(id) }));
  }

  /** Switch to a user account by ID from accountList(). */
  async switchAccount(accountId: string): Promise<void> {
    await this.requireCompanion().sendRequest(
      'SwitchUserAccountEvent',
      new Map([['SwitchAccountID', accountId]]),
    );
  }

  /** Companion-only buttons (no MRP HID usage); each is a press and release. */
  async channelUp(action: InputAction = 'singleTap'): Promise<void> { await this.companionButton(COMPANION_HID.channelUp, action); }
  async channelDown(action: InputAction = 'singleTap'): Promise<void> { await this.companionButton(COMPANION_HID.channelDown, action); }
  async screensaver(action: InputAction = 'singleTap'): Promise<void> { await this.companionButton(COMPANION_HID.screensaver, action); }
  async guide(action: InputAction = 'singleTap'): Promise<void> { await this.companionButton(COMPANION_HID.guide, action); }
  async pageUp(action: InputAction = 'singleTap'): Promise<void> { await this.companionButton(COMPANION_HID.pageUp, action); }
  async pageDown(action: InputAction = 'singleTap'): Promise<void> { await this.companionButton(COMPANION_HID.pageDown, action); }

  // --- Power state (Companion) ---

  /** Ask the device for its power state (Companion FetchAttentionState) and cache it. */
  async fetchPowerState(): Promise<PowerState> {
    const content = await this.companionContent('FetchAttentionState');
    this.updatePowerState(powerStateFromStatus(content.get('state')));
    return this.powerState;
  }

  /** Subscribe to SystemStatus events; changes then emit `powerState`. */
  subscribePowerState(): void {
    this.requireCompanion().sendMessage(
      '_interest',
      new Map([['_regEvents', ['SystemStatus', 'TVSystemStatus']]]),
    );
  }

  // --- Remote control commands ---

  /** MRP HID buttons accept single/double taps or a one-second hold, each with release and flush. */
  async up(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('up', action); }
  async down(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('down', action); }
  async left(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('left', action); }
  async right(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('right', action); }
  async select(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('select', action); }
  async menu(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('menu', action); }
  async home(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('home', action); }
  /** Press Home and hold it for one second before releasing. */
  async homeHold(): Promise<void> { await this.sendKey('home', 'hold'); }
  async topMenu(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('top_menu', action); }
  async playPause(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('play_pause', action); }
  /** Skip forward; `seconds` overrides the app's default interval. */
  async skipForward(seconds?: number): Promise<void> {
    await this.sendMediaCommand(18, seconds ? { skipInterval: seconds } : undefined);
  }
  /** Skip backward; `seconds` overrides the app's default interval. */
  async skipBackward(seconds?: number): Promise<void> {
    await this.sendMediaCommand(19, seconds ? { skipInterval: seconds } : undefined);
  }
  async volumeUp(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('volume_up', action); }
  async volumeDown(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('volume_down', action); }

  // --- Media commands ---

  /** MRP SendCommand media commands; IDs are Command enum values. */
  async play(): Promise<void> { await this.sendMediaCommand(1); }
  async pause(): Promise<void> { await this.sendMediaCommand(2); }
  async stop(): Promise<void> { await this.sendMediaCommand(4); }
  async next(): Promise<void> { await this.sendMediaCommand(5); }
  async previous(): Promise<void> { await this.sendMediaCommand(6); }

  /** Seek to an absolute position in seconds. */
  async setPosition(seconds: number): Promise<void> {
    await this.sendMediaCommand(45, { playbackPosition: seconds });
  }

  /** Set shuffle mode (MRP ChangeShuffleMode). */
  async setShuffle(state: ShuffleState): Promise<void> {
    await this.sendMediaCommand(47, { shuffleMode: state, sendOptions: 0 });
  }

  /** Set repeat mode (MRP ChangeRepeatMode). */
  async setRepeat(state: RepeatState): Promise<void> {
    await this.sendMediaCommand(46, { repeatMode: state, sendOptions: 0 });
  }

  /** Set absolute volume, 0..100. Needs the output device the Apple TV reported on connect. */
  async setVolume(level: number): Promise<void> {
    const conn = this.requireConnection();
    if (!this.outputDeviceUID) throw new Error('No output device known for volume control');
    if (!(level >= 0 && level <= 100)) throw new Error('Volume must be 0..100');
    await conn.sendMRPMessage(await MRPMessage.setVolume(this.outputDeviceUID, level / 100));
  }

  /** Snapshot of currently reported selected outputs. Empty until DeviceInfo arrives. */
  get outputDevices(): OutputDevice[] { return this.reportedOutputs.map(device => ({ ...device })); }

  /** Add selected outputs; resolves only after a matching DeviceInfo update (5s timeout). */
  async addOutputDevices(devices: string[]): Promise<void> { await this.modifyOutputs('add', devices); }
  /** Remove selected outputs; resolves only after a matching DeviceInfo update (5s timeout). */
  async removeOutputDevices(devices: string[]): Promise<void> { await this.modifyOutputs('remove', devices); }
  /** Replace selected outputs, including [] to clear; waits for matching reported state. */
  async setOutputDevices(devices: string[]): Promise<void> { await this.modifyOutputs('set', devices); }

  /** Send type-48 routing changes; only matching reported groups confirm success, not an acknowledgement. */
  private async modifyOutputs(mode: 'add' | 'remove' | 'set', devices: string[]): Promise<void> {
    if (!Array.isArray(devices) || devices.some(id => typeof id !== 'string' || !id.trim()) ||
        new Set(devices).size !== devices.length || (mode !== 'set' && !devices.length)) {
      throw new Error('Output devices must be unique nonempty identifiers');
    }
    const conn = this.requireConnection();
    if (this.pendingRouting) throw new Error('An output routing operation is already pending');
    const ids = [...devices];
    const buffer = await MRPMessage.modifyOutputDevices(mode, ids);
    if (this.pendingRouting) throw new Error('An output routing operation is already pending');
    const identifier = (await MRPMessage.decode(buffer)).identifier as string;
    if (this.pendingRouting) throw new Error('An output routing operation is already pending');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingRouting = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Output routing not confirmed within 5000ms')), 5000);
      const check = (): void => {
        const current = this.reportedOutputs.map(d => d.identifier).filter(id => id !== this.reportedLeader || ids.includes(id));
        const matches = mode === 'remove' ? ids.every(id => !current.includes(id)) :
          ids.every(id => current.includes(id)) && (mode !== 'set' || current.length === ids.length);
        if (matches) finish();
      };
      this.pendingRouting = { identifier, reject: finish, check };
      // ponytail: like pyatv, an already-reported match needs no further update; it may never come.
      conn.sendMRPMessage(buffer).then(check, error => finish(error));
    });
  }

  /** Track DeviceInfo selected groups; reject UUID-correlated envelope errors regardless of discriminator. */
  private handleOutputMessage(msg: Record<string, unknown>): void {
    if (msg.identifier === this.pendingRouting?.identifier && msg.errorCode) {
      this.pendingRouting?.reject(new Error(`Output routing rejected: ${msg.errorDescription ?? msg.errorCode}`));
      return;
    }
    // Types 65/66 update/remove output-device records; neither confirms the selected group.
    if (msg.type !== MessageType.DeviceInfo && msg.type !== MessageType.DeviceInfoUpdate) return;
    const info = msg['.deviceInfoMessage'] as Record<string, unknown> | undefined;
    if (!info) return;
    if (msg.type === MessageType.DeviceInfoUpdate && !Object.hasOwn(info, 'groupedDevices') && !Object.hasOwn(info, 'isGroupLeader')) return;
    const devices: OutputDevice[] = [];
    this.reportedLeader = undefined;
    if (info.isGroupLeader && !info.isProxyGroupPlayer && typeof info.uniqueIdentifier === 'string' && typeof info.name === 'string') {
      devices.push({ name: info.name, identifier: info.uniqueIdentifier });
      this.reportedLeader = info.uniqueIdentifier;
    }
    if (Array.isArray(info.groupedDevices)) {
      for (const device of info.groupedDevices as Record<string, unknown>[]) {
        if (typeof device.deviceUID === 'string' && typeof device.name === 'string') devices.push({ name: device.name, identifier: device.deviceUID });
      }
    }
    const changed = JSON.stringify(devices) !== JSON.stringify(this.reportedOutputs);
    this.reportedOutputs = devices;
    this.pendingRouting?.check();
    if (changed) this.emit('outputDevices', this.outputDevices);
  }

  // --- Device power ---

  /** Put the device to sleep by pressing the HID System Sleep key. */
  async suspend(): Promise<void> {
    const conn = this.requireConnection();
    // Send HID suspend key (usagePage 1, usage 0x82 = SystemSleep)
    const downMsg = await MRPMessage.sendHIDEvent(1, 0x82, true);
    await conn.sendMRPMessage(downMsg);
    await delay(50);
    const upMsg = await MRPMessage.sendHIDEvent(1, 0x82, false);
    await conn.sendMRPMessage(upMsg);
  }

  /** Wake the device (MRP WakeDeviceMessage). */
  async wake(): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.wakeDevice();
    await conn.sendMRPMessage(msg);
  }

  // --- Text input ---

  /** Replace the focused text field's contents. */
  async setText(text: string): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.textInput(text, TextInputActionType.Set);
    await conn.sendMRPMessage(msg);
  }

  /** Insert text into the focused text field. */
  async insertText(text: string): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.textInput(text, TextInputActionType.Insert);
    await conn.sendMRPMessage(msg);
  }

  /** Clear the focused text field. */
  async clearText(): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.textInput('', TextInputActionType.ClearText);
    await conn.sendMRPMessage(msg);
  }

  /** Send a Delete text-input action to the focused text field. */
  async deleteText(): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.textInput('', TextInputActionType.Delete);
    await conn.sendMRPMessage(msg);
  }

  // --- State request ---

  /** Fetch and normalize state using the same model as nowPlaying events. */
  async getNowPlaying(): Promise<NowPlayingInfo> {
    // The transport delivers replies through mrp-message before resolving its waiter.
    await this.getState();
    return this.nowPlaying;
  }

  /** Fetch raw SetState via a queue request; some devices may not reply (#10). */
  async getState(): Promise<Record<string, unknown>> {
    // GetState (type=3) is unreliable over AirPlay transport.
    // PlaybackQueueRequest works on tested devices, but Apple TV HD may time out (#10).
    return this.requestPlaybackQueue({
      location: 0,
      length: 1,
      includeMetadata: true,
    });
  }

  // --- Playback queue / artwork ---

  /**
   * Send a PlaybackQueueRequest and resolve with the SetState reply.
   * Rejects if no reply arrives within 10 s.
   */
  async requestPlaybackQueue(options?: {
    location?: number;
    length?: number;
    includeMetadata?: boolean;
    artworkWidth?: number;
    artworkHeight?: number;
  }): Promise<Record<string, unknown>> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.playbackQueueRequest(options);
    return conn.sendMRPMessageAndWait(msg, MessageType.SetState, 10000);
  }

  /** Fetch artwork for the current item at the requested size; null if the reply has none. */
  async requestArtwork(
    width = 400,
    height = 400,
  ): Promise<Buffer | null> {
    const response = await this.requestPlaybackQueue({
      location: 0,
      length: 1,
      includeMetadata: true,
      artworkWidth: width,
      artworkHeight: height,
    });
    const items = contentItems(response);
    if (items.length > 0) {
      const artworkData = items[0].artworkData;
      if (artworkData && Buffer.isBuffer(artworkData)) {
        return artworkData;
      }
      if (artworkData instanceof Uint8Array) {
        return Buffer.from(artworkData);
      }
    }
    return null;
  }

  // --- Type-safe key command ---

  /** Send any Key, routing it to the matching HID key or media command. */
  async sendKeyCommand(key: Key, action: InputAction = 'singleTap'): Promise<void> {
    validateAction(action);
    if (!HID_KEY_MAP[key] && action !== 'singleTap') throw new Error(`Action modes are not supported for ${key}`);
    switch (key) {
      case Key.Play: return this.play();
      case Key.Pause: return this.pause();
      case Key.Next: return this.next();
      case Key.Previous: return this.previous();
      case Key.Wake: return this.wake();
      case Key.Suspend: return this.suspend();
      case Key.SkipForward: return this.skipForward();
      case Key.SkipBackward: return this.skipBackward();
      case Key.HomeHold: return this.homeHold();
      default: return this.sendKey(key, action);
    }
  }

  // --- Internal ---

  /** @throws If connect() has not completed. */
  private requireConnection(): MRPConnection {
    if (!this.connection) throw new Error('Not connected');
    return this.connection;
  }

  /** Send an MRP SendCommand with optional CommandOptions fields. */
  private async sendMediaCommand(command: number, options?: Record<string, unknown>): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.sendMediaCommand(command, options);
    // pyatv send_and_receive matches the reply by identifier only, not by message type.
    const response = await conn.sendMRPMessageAndWait(msg, undefined);
    if (typeof response.errorCode === 'number' && response.errorCode !== 0) {
      throw new Error(`Media command ${command} rejected: errorCode=${response.errorCode} ${response.errorDescription ?? ''}`);
    }
    const result = response['.sendCommandResultMessage'] as Record<string, unknown> | undefined;
    // pyatv checks only sendError; an absent result extension or omitted proto2 field means NoError.
    const sendError = result?.sendError ?? 0;
    const status = result?.handlerReturnStatus ?? 0;
    if (sendError !== 0) throw new Error(`Media command ${command} rejected: sendError=${sendError}, handlerReturnStatus=${status}`);
  }

  /** @throws If connectCompanion() has not completed. */
  private requireCompanion(): CompanionConnection {
    if (!this.companionConnection) throw new Error('Companion not connected');
    return this.companionConnection;
  }

  /** Send a Companion request and return its `_c` content dict. */
  private async companionContent(identifier: string): Promise<OpackDict> {
    const reply = await this.requireCompanion().sendRequest(identifier, new Map());
    const content = reply.get('_c');
    if (!(content instanceof Map)) throw new Error(`Companion ${identifier}: missing content`);
    return content;
  }

  /** Companion down/up; tap retains its immediate release, hold lasts 1000ms. */
  private async companionButton(code: number, action: InputAction = 'singleTap', tapMs = 0, signal?: AbortSignal): Promise<void> {
    validateAction(action);
    const conn = this.requireCompanion();
    for (let i = 0; i < (action === 'doubleTap' ? 2 : 1); i++) {
      signal?.throwIfAborted();
      await this.checkedCompanion(conn, '_hidC', new Map([['_hBtS', 1], ['_hidC', code]]));
      try { if (action === 'hold' || tapMs) await delay(action === 'hold' ? 1000 : tapMs, undefined, { signal }); }
      finally { await this.checkedCompanion(conn, '_hidC', new Map([['_hBtS', 2], ['_hidC', code]])); }
    }
  }

  /** Requests used by gesture lifecycle must not silently accept error envelopes. */
  private async checkedCompanion(conn: CompanionConnection, id: string, content: OpackDict): Promise<OpackDict> {
    const reply = await conn.sendRequest(id, content);
    if (reply.has('_em') || (reply.has('_ec') && reply.get('_ec') !== 0)) {
      throw new Error(`Companion ${id}: ${reply.get('_em') ?? reply.get('_ec')}`);
    }
    return reply;
  }

  /** Register touch and remote-service sessions once; rollback failed startup. */
  private async startTouch(): Promise<void> {
    if (this.touchSession && this.touchSession.connection === this.companionConnection) return;
    this.touchSession = undefined;
    this.activeTouch = undefined;
    if (this.touchStarting) return this.touchStarting;
    const conn = this.requireCompanion();
    this.touchStarting = (async () => {
      const timestamp = process.hrtime.bigint();
      await this.checkedCompanion(conn, '_touchStart', new Map([['_height', 1000], ['_tFl', 0], ['_width', 1000]]));
      try {
        const local = randomBytes(4).readUInt32LE();
        const reply = await this.checkedCompanion(conn, '_sessionStart', new Map<OpackValue, OpackValue>([['_srvT', 'com.apple.tvremoteservices'], ['_sid', local]]));
        const content = reply.get('_c');
        const remote = content instanceof Map ? content.get('_sid') : undefined;
        if (typeof remote !== 'number' || !Number.isInteger(remote) || remote < 0 || remote > 0xffffffff) {
          throw new Error('Companion _sessionStart: missing or invalid session ID');
        }
        if (this.companionConnection !== conn) throw new Error('Companion disconnected during touch startup');
        this.touchSession = { connection: conn, sid: (BigInt(remote) << 32n) | BigInt(local), timestamp };
      } catch (error) {
        try { await this.checkedCompanion(conn, '_touchStop', new Map([['_i', 1]])); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], `Touch startup failed: ${error}; rollback failed: ${cleanupError}`); }
        throw error;
      }
    })();
    try { await this.touchStarting; } finally { this.touchStarting = undefined; }
  }

  /** Emit the pinned _hidT event; transmission does not confirm visible device action. */
  private sendTouch(x: number, y: number, phase: TouchAction): void {
    const session = this.touchSession;
    if (!session || this.companionConnection !== session.connection) throw new Error('Companion touch session disconnected');
    session.connection.sendMessage('_hidT', new Map<OpackValue, OpackValue>([
      ['_ns', process.hrtime.bigint() - session.timestamp], ['_tFg', 1],
      ['_cx', x], ['_tPh', phase], ['_cy', y],
    ]));
    this.activeTouch = phase === TouchAction.Release || phase === TouchAction.Click ? undefined : { x, y };
  }

  /** Send a validated low-level touch phase. Hold/release require a preceding press. */
  async touchAction(x: number, y: number, phase: TouchAction): Promise<void> {
    validateCoordinates(x, y);
    if (![1, 3, 4, 5].includes(phase)) throw new Error('Unsupported touch action');
    if (this.gestureBusy) throw new Error('A gesture is already in progress');
    if (phase === TouchAction.Press && this.activeTouch) throw new Error('Touch is already pressed');
    if ((phase === TouchAction.Hold || phase === TouchAction.Release) && !this.activeTouch) throw new Error('Touch is not pressed');
    this.gestureBusy = true;
    try { await this.startTouch(); this.sendTouch(x, y, phase); }
    finally { this.gestureBusy = false; }
  }

  /** Companion click: 20ms tap or 1000ms hold, followed by the touch Click phase. */
  async click(action: InputAction = 'singleTap'): Promise<void> {
    validateAction(action);
    if (this.gestureBusy || this.activeTouch) throw new Error('A gesture is already in progress');
    this.gestureBusy = true;
    const controller = new AbortController();
    this.gestureController = controller;
    try {
      await this.startTouch();
      controller.signal.throwIfAborted();
      for (let i = 0; i < (action === 'doubleTap' ? 2 : 1); i++) {
        await this.companionButton(6, action === 'hold' ? 'hold' : 'singleTap', 20, controller.signal);
        this.sendTouch(1000, 1000, TouchAction.Click);
      }
    } finally { this.gestureBusy = false; this.gestureController = undefined; }
  }

  /** Swipe in integral 0..1000 units over 1..60000ms; abort rejects after releasing the finger. */
  async swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number, signal?: AbortSignal): Promise<void> {
    validateCoordinates(startX, startY, endX, endY);
    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 60000) throw new RangeError('Swipe duration must be an integer in 1..60000ms');
    signal?.throwIfAborted();
    if (this.gestureBusy || this.activeTouch) throw new Error('A gesture is already in progress');
    this.gestureBusy = true;
    const controller = new AbortController();
    this.gestureController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.startTouch();
      controller.signal.throwIfAborted();
      this.sendTouch(startX, startY, TouchAction.Press);
      for (let elapsed = 16; elapsed < durationMs; elapsed += 16) {
        await delay(16, undefined, { signal: controller.signal });
        this.sendTouch(Math.round(startX + (endX - startX) * elapsed / durationMs),
          Math.round(startY + (endY - startY) * elapsed / durationMs), TouchAction.Hold);
      }
      await delay(durationMs % 16 || 16, undefined, { signal: controller.signal });
      this.sendTouch(endX, endY, TouchAction.Release);
    } finally {
      signal?.removeEventListener('abort', abort);
      try { this.releaseTouch(); } finally {
        this.gestureController = undefined;
        this.gestureBusy = false;
      }
    }
  }

  /** Release the current finger if its session is still connected. */
  private releaseTouch(): void {
    const finger = this.activeTouch;
    try { if (finger && this.touchSession) this.sendTouch(finger.x, finger.y, TouchAction.Release); }
    finally { this.activeTouch = undefined; }
  }

  /** Release and stop touch registrations; preserve both errors if session and touch shutdown fail. */
  async stopTouch(): Promise<void> {
    this.gestureController?.abort();
    // A failed startup rolls itself back and is reported to its own caller.
    if (this.touchStarting) await this.touchStarting.catch(() => {});
    const session = this.touchSession;
    if (!session) return;
    const errors: unknown[] = [];
    try {
      if (this.activeTouch) this.sendTouch(this.activeTouch.x, this.activeTouch.y, TouchAction.Release);
      await this.checkedCompanion(session.connection, '_sessionStop', new Map<OpackValue, OpackValue>([['_srvT', 'com.apple.tvremoteservices'], ['_sid', session.sid]]));
    } catch (error) {
      errors.push(error);
    } finally {
      this.touchSession = undefined;
      this.activeTouch = undefined;
      try { await this.checkedCompanion(session.connection, '_touchStop', new Map([['_i', 1]])); }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `Touch teardown failed: ${errors.map(String).join('; ')}`);
  }

  /** Cache a power state and emit `powerState` only when it changes. */
  private updatePowerState(state: PowerState): void {
    if (state === this.powerState) return;
    this.powerState = state;
    this.emit('powerState', state);
  }

  /** Re-emit every Companion event and update power state from SystemStatus/TVSystemStatus. */
  private handleCompanionEvent(event: CompanionEvent): void {
    this.emit('companionEvent', event);
    if (event.identifier === 'SystemStatus' || event.identifier === 'TVSystemStatus') {
      const content = event.data.get('_c');
      if (content instanceof Map) this.updatePowerState(powerStateFromStatus(content.get('state')));
    }
  }

  /** Emit `message` for every MRP message, plus typed events for the ones this class understands. */
  private handleMRPMessage(msg: Record<string, unknown>): void {
    // Wrap every message and emit
    const wrapped = new Message(msg);
    this.emit('message', wrapped);

    // Handle SetStateMessage (type 4)
    if (msg.type === MessageType.SetState) {
      const setState = msg['.setStateMessage'] as
        | Record<string, unknown>
        | undefined;
      if (!setState) return;

      const supportedCmds = setState.supportedCommands as
        | Record<string, unknown>
        | undefined;
      if (supportedCmds) {
        const commands = SupportedCommand.fromList(supportedCmds);
        this.emit('supportedCommands', commands);
      }

      const playbackQueue = setState.playbackQueue as
        | Record<string, unknown>
        | undefined;
      if (playbackQueue) {
        this.emit('playbackQueue', playbackQueue);
      }
    }

    const stateFields: Partial<Record<MessageType, string>> = {
      [MessageType.SetState]: '.setStateMessage', [MessageType.UpdateContentItem]: '.updateContentItemMessage',
      [MessageType.SetNowPlayingClient]: '.setNowPlayingClientMessage', [MessageType.SetNowPlayingPlayer]: '.setNowPlayingPlayerMessage',
      [MessageType.UpdateClient]: '.updateClientMessage', [MessageType.RemoveClient]: '.removeClientMessage',
      [MessageType.RemovePlayer]: '.removePlayerMessage', [MessageType.SetDefaultSupportedCommands]: '.setDefaultSupportedCommandsMessage',
    };
    const field = stateFields[msg.type as MessageType];
    const payload = field ? msg[field] as Record<string, unknown> | undefined : undefined;
    if (payload && this.playerState.update(msg.type as number, payload)) this.publishNowPlaying();
    if (msg.type === MessageType.VolumeControlAvailability) {
      const volume = msg['.volumeControlAvailabilityMessage'] as Record<string, unknown> | undefined;
      this.volumeAvailability = volume ? { ...this.volumeAvailability, ...volume } : undefined;
      this.emit('featureAvailability');
    }
    this.handleOutputMessage(msg);

    // DeviceInfo (type 15): remember the output device for SetVolume (pyatv: clusterID or deviceUID)
    if (msg.type === MessageType.DeviceInfo) {
      const info = msg['.deviceInfoMessage'] as Record<string, unknown> | undefined;
      const uid = (info?.clusterID || info?.deviceUID) as string | undefined;
      if (uid) { this.outputDeviceUID = uid; this.emit('featureAvailability'); }
    }

    // VolumeDidChange (type 52): track absolute volume for our output device as 0..100
    if (msg.type === MessageType.VolumeDidChange) {
      const vol = msg['.volumeDidChangeMessage'] as Record<string, unknown> | undefined;
      if (vol && vol.outputDeviceUID === this.outputDeviceUID && typeof vol.volume === 'number') {
        this.volume = Math.round(vol.volume * 1000) / 10;
        this.emit('volume', this.volume);
      }
    }

    // Handle KeyboardMessage (type 23)
    if (msg.type === MessageType.Keyboard) {
      const kb = msg['.keyboardMessage'] as Record<string, unknown> | undefined;
      if (kb) {
        const attrs = kb.attributes as Record<string, unknown> | undefined;
        const info: KeyboardInfo = {
          focused: (kb.state as number) === 1,
          title: attrs?.title as string | undefined,
          prompt: attrs?.prompt as string | undefined,
          inputTraits: attrs?.inputTraits as Record<string, unknown> | undefined,
        };
        this.emit('keyboard', info);
      }
    }

    // Handle TextInputMessage (type 25)
    if (msg.type === MessageType.TextInput) {
      const ti = msg['.textInputMessage'] as Record<string, unknown> | undefined;
      if (ti) {
        const event: TextInputEvent = {
          text: ti.text as string | undefined,
          actionType: ti.actionType as number | undefined,
          timestamp: ti.timestamp as number | undefined,
        };
        this.emit('textInput', event);
      }
    }
  }

  /** Discard runtime evidence when its transport session ends. */
  private resetRuntimeState(): void {
    this.playerState = new PlayerState();
    this.volumeAvailability = undefined;
    this.outputDeviceUID = undefined;
    this.volume = undefined;
    this.nowPlaying = new NowPlayingInfo({ hasPlayback: false }, {});
    this.emit('featureAvailability');
  }

  /** Publish a fresh snapshot and notify consumers to re-query runtime availability. */
  private publishNowPlaying(): void {
    this.nowPlaying = this.playerState.snapshot();
    this.emit('nowPlaying', this.nowPlaying);
    this.emit('featureAvailability');
  }

  /** Each MRP tap uses 50ms down/up and existing flush; hold uses 1000ms. */
  private async sendKey(key: string, action: InputAction = 'singleTap'): Promise<void> {
    validateAction(action);
    const conn = this.requireConnection();
    const hid = HID_KEY_MAP[key];
    if (!hid) throw new Error(`Unknown key: ${key}`);
    for (let i = 0; i < (action === 'doubleTap' ? 2 : 1); i++) {
      await conn.sendMRPMessage(await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, true));
      try { await delay(action === 'hold' ? 1000 : 50); }
      finally { await conn.sendMRPMessage(await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, false)); }
      await conn.sendMRPMessage(await MRPMessage.sendCommand(MessageType.GenericMessage));
    }
  }

  /** `name (address:port) [model]`. */
  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}
