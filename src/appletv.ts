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
import { MRP_ERROR_NO_NOW_PLAYING_CLIENT, type MRPConnection, type MRPReplyError } from './mrp/connection.js';
import { Credentials } from './credentials.js';
import { MRPMessage, HID_KEY_MAP, MessageType, PLAYER_STATE_FIELDS } from './mrp/messages.js';
import { NowPlayingInfo } from './now-playing-info.js';
import { DEFAULT_PLAYER, PlayerState, carriesState } from './mrp/player-state.js';
import { Command, SupportedCommand } from './supported-command.js';
import { Message } from './message.js';
import { CompanionConnection } from './companion/connection.js';
import { CompanionPairSetup } from './companion/pair-setup.js';
import { readTextSession, rtiClearTextPayload, rtiInputTextPayload } from './companion/text-input.js';
import { OpackFloat, type OpackDict, type OpackValue } from './companion/opack.js';
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

/** MRP TextInputMessage action types: `TextInputEvent.actionType` values, and the Delete that deleteText sends. */
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

/** Device power as reported by Companion SystemStatus. */
export enum PowerState {
  Unknown = 'unknown',
  Off = 'off',
  On = 'on',
}

/** Every button action mode, in documentation order. */
export const INPUT_ACTIONS = ['singleTap', 'doubleTap', 'hold'] as const;

/** Text-field focus from Companion RTI (`_tiStart` reply, `_tiStarted`/`_tiStopped` events). */
export enum KeyboardFocusState {
  Unknown = 'unknown',
  Unfocused = 'unfocused',
  Focused = 'focused',
}

/** Button action timing: tap retains existing defaults; hold lasts one second. */
export type InputAction = typeof INPUT_ACTIONS[number];
/** Companion touch phase values. */
export enum TouchAction { Press = 1, Hold = 3, Release = 4, Click = 5 }
/** A currently selected output, not a discovered/available AirPlay receiver. */
export interface OutputDevice { name: string; identifier: string }

/** Reject invalid actions before any input is sent. */
function validateAction(action: InputAction): void {
  if (!INPUT_ACTIONS.includes(action)) throw new Error(`Unsupported input action: ${action}`);
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

/** Companion `_hidC` button codes. */
const COMPANION_HID = {
  up: 1, down: 2, left: 3, right: 4, menu: 5, select: 6, home: 7,
  volumeUp: 8, volumeDown: 9, screensaver: 11, suspend: 12, wake: 13,
  playPause: 14, channelUp: 15, channelDown: 16, guide: 17, pageUp: 18, pageDown: 19,
} as const;

/** Companion SystemStatus `state`: 1 asleep, 2 screensaver, 3 awake, 4 idle. */
function powerStateFromStatus(state: unknown): PowerState {
  if (state === 1) return PowerState.Off;
  if (state === 2 || state === 3 || state === 4) return PowerState.On;
  return PowerState.Unknown;
}

/** RTI focus from a `_tiStart` reply or `_tiStarted`/`_tiStopped` content: focused only with a `_tiD` archive (a Buffer, as text edits need). */
function textFocusFrom(content: OpackDict): KeyboardFocusState {
  return Buffer.isBuffer(content.get('_tiD')) ? KeyboardFocusState.Focused : KeyboardFocusState.Unfocused;
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
 * Events: `connect`, `close`, `error`, `message`, `mrpDiagnostic`, `nowPlaying`, `supportedCommands`,
 * `playbackQueue`, `featureAvailability`, `keyboard`, `textInput`, `textFocusState`, `volume`, `powerState`, `companionConnect`,
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
  private companionMediaControls?: number;
  nowPlaying = new NowPlayingInfo({ hasPlayback: false }, {});

  /**
   * Volume capabilities arrive pushed (type 17), as the reply to our handshake request (type 63),
   * or as a later change for one output device (type 64, applied only for ours). A pushed type 17
   * without fields clears them; a type 63 or 64 without capabilities leaves earlier evidence alone.
   */
  private handleVolumeCapabilities(msg: Record<string, unknown>): void {
    let volume: Record<string, unknown> | undefined;
    if (msg.type === MessageType.VolumeControlAvailability) {
      volume = msg['.volumeControlAvailabilityMessage'] as Record<string, unknown> | undefined;
      this.volumeAvailability = volume ? { ...this.volumeAvailability, ...volume } : undefined;
      this.emit('featureAvailability');
      return;
    }
    if (msg.type === MessageType.GetVolumeControlCapabilitiesResult) {
      volume = (msg['.getVolumeControlCapabilitiesResultMessage'] as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
    } else if (msg.type === MessageType.VolumeControlCapabilitiesDidChange) {
      const change = msg['.volumeControlCapabilitiesDidChangeMessage'] as { capabilities?: Record<string, unknown>; outputDeviceUID?: string } | undefined;
      if (change?.outputDeviceUID && change.outputDeviceUID === this.outputDeviceUID) volume = change.capabilities;
    } else if (msg.type === MessageType.UpdateOutputDevice) {
      // After renewed volume updates, tvOS may report the output's capability only here.
      const update = msg['.updateOutputDeviceMessage'] as Record<string, Record<string, unknown>[] | undefined> | undefined;
      const device = [...update?.clusterAwareOutputDevices ?? [], ...update?.outputDevices ?? []]
        .find(entry => this.outputDeviceUID && entry.uniqueIdentifier === this.outputDeviceUID);
      if (device && typeof device.isVolumeControlAvailable === 'boolean' && typeof device.volumeCapabilities === 'number') {
        volume = { volumeControlAvailable: device.isVolumeControlAvailable, volumeCapabilities: device.volumeCapabilities };
      }
    }
    if (!volume) return;
    this.volumeAvailability = { ...this.volumeAvailability, ...volume };
    this.emit('featureAvailability');
  }

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
    const transport = this.connection && this.readyTransports.has(this.connection) ? 'mrp' :
      this.companionConnection && this.readyTransports.has(this.companionConnection) ? 'companion' : undefined;
    if (id !== undefined) {
      if (transport === 'companion') {
        if (this.companionMediaControls === undefined) return 'unknown';
        const flag: Partial<Record<Feature, number>> = {
          play: 0x0001, pause: 0x0002, next: 0x0004, previous: 0x0008,
          skipForward: 0x0200, skipBackward: 0x0400,
        };
        const capability = flag[feature];
        return capability === undefined ? 'unknown' : this.companionMediaControls & capability ? 'supported' : 'unavailable';
      }
      const advertised = this.playerState.commands;
      if (!advertised) return 'unknown';
      const command = advertised.find(cmd => cmd.command === id);
      return !command ? 'unsupported' : command.enabled ? 'supported' : 'unavailable';
    }
    if (feature === 'setVolume' || feature === 'volumeUp' || feature === 'volumeDown') {
      if (transport === 'companion') {
        if (this.companionMediaControls === undefined) return 'unknown';
        return this.companionMediaControls & 0x0100 ? 'supported' : 'unavailable';
      }
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
  private companionVolume?: number;
  private mrpVolume?: number;
  private mrpVolumeRequested = false;
  /**
   * Last absolute volume (0..100) reported by the selected transport; undefined until one
   * arrives, and again (with a `volume` event carrying undefined) when the MRP output loses
   * absolute volume.
   */
  volume?: number;
  powerState: PowerState = PowerState.Unknown;
  /** Last text-field focus from Companion RTI; set by connectCompanion()'s `_tiStart` reply, then `_tiStarted`/`_tiStopped` events; unknown before Companion connects and after it closes. */
  textFocusState: KeyboardFocusState = KeyboardFocusState.Unknown;

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
      if (!this.companionConnection) this.updatePowerState(PowerState.Unknown);
      // A failed setup reports through connect()'s rejection, never as `close`.
      if (this.readyTransports.has(connection)) this.emit('close');
    });
    connection.on('error', (err) => { if (this.airPlayErrorSource === connection && this.listenerCount('error')) this.emit('error', err); });
    if (this.listenerCount('mrpDiagnostic')) {
      connection.on('mrp-diagnostic', diagnostic => {
        if (this.connection === connection && this.listenerCount('mrpDiagnostic')) this.emit('mrpDiagnostic', diagnostic);
      });
    }
    connection.on('mrp-message', (msg: Record<string, unknown>) => {
      if (this.connection !== connection) return;
      this.handleMRPMessage(msg);
    });

    try {
      await connection.connect();
      if (this.connection !== connection) throw new Error('Connection closed during setup');
      this.readyTransports.add(connection);
      this.requestMRPVolume();
      this.emit('connect');
    } catch (err) {
      if (this.connection === connection) {
        connection.close();
        if (this.connection === connection) this.connection = undefined;
      }
      throw err;
    }
  }

  /**
   * Cancel gestures, attempt best-effort touch cleanup, then close both transports; never rejects.
   * Touch teardown errors are ignored (call stopTouch() first to observe them). A touch startup
   * still in flight is abandoned (closing Companion ends it), not awaited.
   */
  async close(): Promise<void> {
    this.gestureController?.abort();
    if (!this.touchStarting) await this.stopTouch().catch(() => {});
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
    this.clearCompanionControlState();
    this.updatePowerState(PowerState.Unknown);
    this.updateTextFocusState(KeyboardFocusState.Unknown);
    if (companion && this.readyTransports.has(companion)) this.emit('companionClose');
    if (connection && this.readyTransports.has(connection)) this.emit('close');
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
   * Open the Companion connection, send `_systemInfo`, register a TV Remote session (`TVRCSessionStart`,
   * best effort), then open an RTI session (`_tiStart`) so `textFocusState` is known and
   * `_tiStarted`/`_tiStopped` events can arrive; emits `companionConnect` once ready.
   * A rejected `_tiStart` only emits `companionError` and leaves `textFocusState` unknown.
   * @throws If no Companion port was given or discovered, or the TV rejects `_systemInfo`.
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
      this.clearCompanionControlState();
      this.updatePowerState(PowerState.Unknown);
      this.updateTextFocusState(KeyboardFocusState.Unknown);
      if (this.readyTransports.has(connection)) this.emit('companionClose');
    });
    connection.on('error', (err) => { if (this.companionErrorSource === connection) this.emit('companionError', err); });
    connection.on('event', (event: CompanionEvent) => {
      if (this.companionConnection !== connection) return;
      this.handleCompanionEvent(event, connection);
    });

    try {
      await connection.connect();
      // Without _systemInfo the TV answers app, account and power requests with "No request handler".
      await connection.sendRequest('_systemInfo', new Map<OpackValue, OpackValue>([
        ['_bf', 0], ['_cf', 512], ['_clFl', 128], ['_i', this.deviceId.replaceAll(':', '').toLowerCase()],
        ['_idsID', credentials.clientId], ['_pubID', this.deviceId], ['_sf', 256], ['_sv', '170.18'],
        ['model', this.model], ['name', this.name],
      ]));
      // Register the remote service before TVRCSessionStart and app/power/RTI requests (pyatv #2855).
      await this.startTouch();
      connection.sendMessage('_interest', new Map([['_regEvents', ['_iMC']]]));
      // tvOS 26.4+ (Apple TV HD on 26.6) silently drops power and app-list requests until a TV Remote session
      // is registered (pyatv #2845). Older TVs reject the message, so failure is ignored.
      await connection.sendRequest('TVRCSessionStart', new Map([['ProtocolVersionKey', '1.2']])).catch(() => {});
      // The TV pushes _tiStarted/_tiStopped only to clients with an open RTI session.
      // Best effort: a TV that rejects _tiStart still serves every other Companion request.
      await this.startTextSession().catch((err: Error) => this.emit('companionError', err));
      if (this.companionConnection !== connection) throw new Error('Companion closed during setup');
      this.readyTransports.add(connection);
      this.emit('companionConnect');
    } catch (err) {
      if (this.companionConnection === connection) {
        connection.close();
        if (this.companionConnection === connection) this.companionConnection = undefined;
      }
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
    // ponytail: anything with a URL scheme is a URL.
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

  // --- Power state (MRP DeviceInfo, or Companion) ---

  /**
   * Power state. Over Companion, asks FetchAttentionState and caches the answer. Over MRP alone, returns the
   * state from the last DeviceInfo, which the TV sends at connect and again on every sleep and wake.
   */
  async fetchPowerState(): Promise<PowerState> {
    if (!this.companionConnection && this.connection) return this.powerState;
    const content = await this.companionContent('FetchAttentionState');
    this.updatePowerState(powerStateFromStatus(content.get('state')));
    return this.powerState;
  }

  /** Subscribe to SystemStatus events; changes then emit `powerState`. MRP pushes DeviceInfoUpdate unasked. */
  subscribePowerState(): void {
    if (!this.companionConnection && this.connection) return;
    this.requireCompanion().sendMessage(
      '_interest',
      new Map([['_regEvents', ['SystemStatus', 'TVSystemStatus']]]),
    );
  }

  // --- Remote control commands ---

  /** Navigation buttons route to Companion when it is the only open control transport. */
  async up(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('up', COMPANION_HID.up, action); }
  async down(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('down', COMPANION_HID.down, action); }
  async left(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('left', COMPANION_HID.left, action); }
  async right(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('right', COMPANION_HID.right, action); }
  async select(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('select', COMPANION_HID.select, action); }
  async menu(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('menu', COMPANION_HID.menu, action); }
  async home(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('home', COMPANION_HID.home, action); }
  /** Press Home and hold it for one second before releasing. */
  async homeHold(): Promise<void> { await this.home('hold'); }
  async topMenu(action: InputAction = 'singleTap'): Promise<void> { await this.sendKey('top_menu', action); }
  async playPause(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('playPause', COMPANION_HID.playPause, action); }
  /** Skip forward by positive finite seconds; omitted uses the MRP app default or Companion's ten seconds. */
  async skipForward(seconds?: number): Promise<void> { await this.controlMedia('skipForward', 18, 7, seconds, 1); }
  /** Skip backward by positive finite seconds; omitted uses the MRP app default or Companion's ten seconds. */
  async skipBackward(seconds?: number): Promise<void> { await this.controlMedia('skipBackward', 19, 7, seconds, -1); }
  async volumeUp(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('volumeUp', COMPANION_HID.volumeUp, action); }
  async volumeDown(action: InputAction = 'singleTap'): Promise<void> { await this.controlButton('volumeDown', COMPANION_HID.volumeDown, action); }

  // --- Media commands ---

  /** MRP SendCommand media commands; Companion-only sessions use `_mcc`. */
  async play(): Promise<void> { await this.controlMedia('play', 1, 1); }
  async pause(): Promise<void> { await this.controlMedia('pause', 2, 2); }
  async stop(): Promise<void> { await this.sendMediaCommand(4); }
  async next(): Promise<void> { await this.controlMedia('next', 5, 3); }
  async previous(): Promise<void> { await this.controlMedia('previous', 6, 4); }

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

  /** Set absolute volume, 0..100; an accepted Companion request is not a volume observation. */
  async setVolume(level: number): Promise<void> {
    if (!(Number.isFinite(level) && level >= 0 && level <= 100)) throw new Error('Volume must be 0..100');
    if (this.controlTransport('setVolume') === 'companion') {
      if (this.featureAvailability('setVolume') !== 'supported') throw new Error('Companion volume control is unavailable');
      await this.checkedCompanion(this.requireCompanion(), '_mcc', new Map<OpackValue, OpackValue>([['_mcc', 6], ['_vol', new OpackFloat(level / 100)]]));
      return;
    }
    const conn = this.requireConnection();
    if (!this.outputDeviceUID) throw new Error('No output device known for volume control');
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
      // ponytail: an already-reported match needs no further update; it may never come.
      conn.sendMRPMessage(buffer).then(check, error => finish(error));
    });
  }

  /** Track DeviceInfo selected groups; reject UUID-correlated envelope errors regardless of discriminator. */
  private handleOutputMessage(msg: Record<string, unknown>): void {
    if (this.pendingRouting && msg.identifier === this.pendingRouting.identifier && msg.errorCode) {
      this.pendingRouting.reject(new Error(`Output routing rejected: ${msg.errorDescription ?? msg.errorCode}`));
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

  /** Put the device to sleep. */
  async suspend(): Promise<void> {
    if (this.controlTransport('suspend') === 'companion') {
      await this.companionButton(COMPANION_HID.suspend);
      return;
    }
    const conn = this.requireConnection();
    const downMsg = await MRPMessage.sendHIDEvent(1, 0x82, true);
    await conn.sendMRPMessage(downMsg);
    await delay(50);
    const upMsg = await MRPMessage.sendHIDEvent(1, 0x82, false);
    await conn.sendMRPMessage(upMsg);
  }

  /** Wake the device. */
  async wake(): Promise<void> {
    if (this.controlTransport('wake') === 'companion') {
      await this.companionButton(COMPANION_HID.wake);
      return;
    }
    const conn = this.requireConnection();
    await conn.sendMRPMessage(await MRPMessage.wakeDevice());
  }

  // --- Text input ---

  /** Replace the focused text field's contents (Companion); resolves with the new text. */
  async setText(text: string): Promise<string> { return this.editText(text, true); }

  /** Insert text at the cursor of the focused text field (Companion); resolves with the new text. */
  async insertText(text: string): Promise<string> { return this.editText(text, false); }

  /** Clear the focused text field (Companion); resolves with the empty text. */
  async clearText(): Promise<string> { return this.editText('', true); }

  /** Read the focused text field's contents (Companion) without editing it. */
  async getText(): Promise<string> { return this.editText('', false); }

  /**
   * Re-ask whether a text field is focused (Companion RTI) and cache it as `textFocusState`.
   * connectCompanion() already opens the RTI session that receives `_tiStarted`/`_tiStopped`;
   * this restarts it (`_tiStop`/`_tiStart`) for a fresh answer.
   */
  async fetchTextFocusState(): Promise<KeyboardFocusState> {
    await this.restartTextSession();
    return this.textFocusState;
  }

  /**
   * Restart the RTI session for fresh state, then send `_tiC` edits.
   * Modern tvOS ignores the MRP TextInputMessage, so text input needs connectCompanion().
   * @throws If no text field is focused (the `_tiStart` reply has no `_tiD`).
   */
  private async editText(text: string, clear: boolean): Promise<string> {
    const conn = this.requireCompanion();
    const archive = await this.restartTextSession();
    if (!Buffer.isBuffer(archive)) throw new Error('No text field is focused');
    const { sessionUUID, text: current } = readTextSession(archive);
    const send = (payload: Buffer) => conn.sendMessage('_tiC', new Map<OpackValue, OpackValue>([['_tiV', 1], ['_tiD', payload]]));
    if (clear) send(rtiClearTextPayload(sessionUUID));
    if (text) send(rtiInputTextPayload(sessionUUID, text));
    return (clear ? '' : current) + text;
  }

  /** `_tiStop` then `_tiStart`, so the reply reflects the current field; see startTextSession(). */
  private async restartTextSession(): Promise<OpackValue | undefined> {
    await this.requireCompanion().sendRequest('_tiStop', new Map());
    return this.startTextSession();
  }

  /** Send `_tiStart`, record focus from its reply, and return the reply's `_tiD` archive. */
  private async startTextSession(): Promise<OpackValue | undefined> {
    const content = await this.companionContent('_tiStart');
    this.updateTextFocusState(textFocusFrom(content));
    return content.get('_tiD');
  }

  /** Send a Delete text-input action to the focused text field. */
  async deleteText(): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.textInput('', TextInputActionType.Delete);
    await conn.sendMRPMessage(msg);
  }

  // --- State request ---

  /**
   * Return the received active-player snapshot used by nowPlaying events after device routing selection.
   * A selected empty client (idle TV) with no selected player resolves as nothing playing without a queue request.
   * Without selected state evidence, request a queue reply; its timeout/error still rejects, except
   * error 35 (no now-playing client, sent by an idle Apple TV), which resolves with the current
   * snapshot: pushed state if any arrived, else nothing playing (#10).
   * After a routing selection, a successful reply resolves with the selected player's snapshot (nothing playing if it has no state).
   * Without one, a reply lacking state for the model's current player rejects rather than inventing absent playback.
   * Requires an open connection and does not extrapolate position or force a refresh.
   */
  async getNowPlaying(): Promise<NowPlayingInfo> {
    this.requireConnection();
    if (!this.playerState.hasSelectedSnapshot) {
      // The transport delivers replies through mrp-message before resolving its waiter.
      let response: Record<string, unknown>;
      try {
        response = await this.getState();
      } catch (err) {
        if ((err as MRPReplyError).errorCode === MRP_ERROR_NO_NOW_PLAYING_CLIENT) return this.nowPlaying;
        throw err;
      }
      if (this.playerState.routingSelected) return this.nowPlaying;
      const state = response['.setStateMessage'] as Record<string, unknown> | undefined;
      const path = state?.playerPath as { client?: { bundleIdentifier?: string }; player?: { identifier?: string } } | undefined;
      const replyMatchesPlayer = this.nowPlaying.appBundleIdentifier === (path?.client?.bundleIdentifier ?? '') &&
        this.nowPlaying.playerIdentifier === (path?.player?.identifier ?? DEFAULT_PLAYER);
      // A real reply may establish legacy unrouted state; an empty/unrelated reply cannot validate an earlier push.
      if (!(state && carriesState(state) && replyMatchesPlayer && this.playerState.hasSnapshot)) {
        throw new Error('No active-player state received');
      }
    }
    return this.nowPlaying;
  }

  /** Fetch raw SetState via a queue request; rejects with `errorCode` 35 when nothing is playing (#10). */
  async getState(): Promise<Record<string, unknown>> {
    // GetState (type=3) is unreliable over AirPlay transport.
    // An idle Apple TV answers PlaybackQueueRequest with a typeless error 35 reply (#10).
    return this.requestPlaybackQueue({
      location: 0,
      length: 1,
      includeMetadata: true,
    });
  }

  // --- Playback queue / artwork ---

  /**
   * Send a PlaybackQueueRequest and resolve with the SetState reply.
   * Rejects on a same-identifier error reply (the Error carries `errorCode`) or if no reply arrives within 10 s.
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
      case Key.Up: return this.up(action);
      case Key.Down: return this.down(action);
      case Key.Left: return this.left(action);
      case Key.Right: return this.right(action);
      case Key.Select: return this.select(action);
      case Key.Menu: return this.menu(action);
      case Key.Home: return this.home(action);
      case Key.PlayPause: return this.playPause(action);
      case Key.VolumeUp: return this.volumeUp(action);
      case Key.VolumeDown: return this.volumeDown(action);
      default: return this.sendKey(key, action);
    }
  }

  // --- Internal ---

  /** @throws If connect() has not completed. */
  private requireConnection(): MRPConnection {
    if (!this.connection) throw new Error('Not connected');
    return this.connection;
  }
  /**
   * Internal control routing seam. Existing callers keep MRP priority when both transports are
   * open; a Companion-only session never creates an MRP connection.
   */
  protected controlTransport(_feature: Feature): 'mrp' | 'companion' {
    if (this.connection && this.readyTransports.has(this.connection)) return 'mrp';
    if (this.companionConnection && this.readyTransports.has(this.companionConnection)) return 'companion';
    throw new Error('Not connected: no usable control transport');
  }

  private async controlButton(feature: Feature, companionCode: number, action: InputAction): Promise<void> {
    validateAction(action);
    if (this.controlTransport(feature) === 'companion') await this.companionButton(companionCode, action);
    else await this.sendKey(feature === 'playPause' ? 'play_pause' : feature === 'volumeUp' ? 'volume_up' : feature === 'volumeDown' ? 'volume_down' : feature, action);
  }

  private async controlMedia(feature: Feature, mrpCommand: number, companionCommand: number, seconds?: number, sign?: 1 | -1): Promise<void> {
    if (seconds !== undefined && !(Number.isFinite(seconds) && seconds > 0)) {
      throw new Error('Skip interval must be a finite positive number of seconds');
    }
    if (this.controlTransport(feature) === 'mrp') {
      await this.sendMediaCommand(mrpCommand, seconds === undefined ? undefined : { skipInterval: seconds });
      return;
    }
    const content: OpackDict = new Map([['_mcc', companionCommand]]);
    if (sign) content.set('_skpS', new OpackFloat((seconds ?? 10) * sign));
    await this.checkedCompanion(this.requireCompanion(), '_mcc', content);
  }


  /** Send an MRP SendCommand with optional CommandOptions fields. */
  private async sendMediaCommand(command: number, options?: Record<string, unknown>): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.sendMediaCommand(command, options);
    // Match the reply by identifier only, not by message type.
    const response = await conn.sendMRPMessageAndWait(msg, undefined);
    if (typeof response.errorCode === 'number' && response.errorCode !== 0) {
      throw new Error(`Media command ${command} rejected: errorCode=${response.errorCode} ${response.errorDescription ?? ''}`);
    }
    const result = response['.sendCommandResultMessage'] as Record<string, unknown> | undefined;
    // Only sendError is checked; an absent result extension or omitted proto2 field means NoError.
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
      // A real TV drops this session once an AirPlay/MRP connection is open; it is already stopped.
      if (!(error instanceof Error && error.message.endsWith('Session not found'))) errors.push(error);
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

  /** Cache a text-focus state and emit `textFocusState` only when it changes. */
  private updateTextFocusState(state: KeyboardFocusState): void {
    if (state === this.textFocusState) return;
    this.textFocusState = state;
    this.emit('textFocusState', state);
  }

  /** Re-emit every Companion event and update Companion-derived observational state. */
  private handleCompanionEvent(event: CompanionEvent, connection: CompanionConnection): void {
    this.emit('companionEvent', event);
    const content = event.data.get('_c');
    if (event.identifier === 'SystemStatus' || event.identifier === 'TVSystemStatus') {
      this.updatePowerState(powerStateFromStatus(content instanceof Map ? content.get('state') : undefined));
    }
    if (event.identifier === '_tiStarted' || event.identifier === '_tiStopped') {
      this.updateTextFocusState(content instanceof Map ? textFocusFrom(content) : KeyboardFocusState.Unfocused);
    }
    if (event.identifier === '_iMC') this.updateCompanionMediaControls(content, connection);
  }

  private updateCompanionMediaControls(content: OpackValue | undefined, connection: CompanionConnection): void {
    const flags = content instanceof Map ? content.get('_mcF') : undefined;
    const next = content instanceof Map && flags === undefined ? 0 :
      typeof flags === 'number' && Number.isFinite(flags) && Number.isInteger(flags) && flags >= 0 ? flags : undefined;
    if (next !== this.companionMediaControls) {
      this.companionMediaControls = next;
      this.emit('featureAvailability');
    }
    if (next !== undefined && next & 0x0100) {
      void this.fetchCompanionVolume(connection).catch(error => {
        if (this.companionConnection === connection) this.emit('companionError', error);
      });
    }
  }

  private async fetchCompanionVolume(connection: CompanionConnection): Promise<void> {
    const reply = await this.checkedCompanion(connection, '_mcc', new Map([['_mcc', 5]]));
    if (this.companionConnection !== connection) return;
    const content = reply.get('_c');
    const volume = content instanceof Map ? content.get('_vol') : undefined;
    if (!(typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 1)) return;
    this.companionVolume = Math.round(volume * 1000) / 10;
    if (!this.connection && this.volume !== this.companionVolume) {
      this.volume = this.companionVolume;
      this.emit('volume', this.volume);
    }
  }

  private clearCompanionControlState(): void {
    const hadControls = this.companionMediaControls !== undefined;
    this.companionMediaControls = undefined;
    this.companionVolume = undefined;
    if (!this.connection) this.volume = undefined;
    if (hadControls) this.emit('featureAvailability');
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

    const field = PLAYER_STATE_FIELDS[msg.type as MessageType];
    const payload = field ? msg[field] as Record<string, unknown> | undefined : undefined;
    if (payload && this.playerState.update(msg.type as number, payload)) this.publishNowPlaying();
    this.handleVolumeCapabilities(msg);
    // The output lost absolute volume (e.g. AirPods detached): its last level no longer applies,
    // and the next absolute output is queried again by requestMRPVolume().
    if (this.mrpVolume !== undefined && this.featureAvailability('setVolume') !== 'supported') {
      this.mrpVolume = undefined;
      this.mrpVolumeRequested = false;
      this.volume = undefined;
      this.emit('volume', undefined);
    }
    this.handleOutputMessage(msg);

    // DeviceInfo and DeviceInfoUpdate carry logicalDeviceCount: 0 while the Apple TV sleeps, 1 once awake
    // (hardware, tvOS 26.6). A sleeping Apple TV HD rejects every Companion power request, so this is the power source.
    if (msg.type === MessageType.DeviceInfo || msg.type === MessageType.DeviceInfoUpdate) {
      const count = (msg['.deviceInfoMessage'] as Record<string, unknown> | undefined)?.logicalDeviceCount;
      if (typeof count === 'number') this.updatePowerState(count > 0 ? PowerState.On : PowerState.Off);
    }

    // DeviceInfo (type 15): remember the output device for SetVolume (clusterID or deviceUID)
    if (msg.type === MessageType.DeviceInfo) {
      const info = msg['.deviceInfoMessage'] as Record<string, unknown> | undefined;
      const uid = (info?.clusterID || info?.deviceUID) as string | undefined;
      if (uid) { this.outputDeviceUID = uid; this.emit('featureAvailability'); }
    }

    // DeviceInfoUpdate (type 37) follows an output change. Switching back to a HomePod pushes only
    // capability 0 and no level until the next press; renewed volume updates report the real ones.
    if (msg.type === MessageType.DeviceInfoUpdate && this.mrpVolume === undefined) this.renewVolumeUpdates();

    // VolumeDidChange (type 52): track absolute volume for our output device as 0..100
    if (msg.type === MessageType.VolumeDidChange) {
      const vol = msg['.volumeDidChangeMessage'] as Record<string, unknown> | undefined;
      if (vol && vol.outputDeviceUID === this.outputDeviceUID && typeof vol.volume === 'number' && Number.isFinite(vol.volume)) {
        this.mrpVolume = Math.round(vol.volume * 1000) / 10;
        this.volume = this.mrpVolume;
        this.emit('volume', this.volume);
      }
    }
    this.requestMRPVolume();

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

  /**
   * Ask for the starting absolute volume, since VolumeDidChange arrives only on a change. Needs
   * `setVolume` support (absolute capability and the output UID); a VolumeDidChange always wins.
   * 0 is not a reading: tvOS answers 0 for any unknown UID and once did while AirPods attached.
   * A timeout, error, zero or out-of-range reply leaves `volume` unset and the next MRP message
   * (normally a capability update) asks again.
   */
  private requestMRPVolume(): void {
    const connection = this.connection;
    const uid = this.outputDeviceUID;
    if (this.mrpVolumeRequested || !connection || !this.readyTransports.has(connection) || !uid) return;
    if (this.mrpVolume !== undefined || this.featureAvailability('setVolume') !== 'supported') return;
    this.mrpVolumeRequested = true;
    void (async () => {
      const reply = await connection.sendMRPMessageAndWait(await MRPMessage.getVolume(uid), MessageType.GetVolumeResult);
      const volume = (reply['.getVolumeResultMessage'] as { volume?: unknown } | undefined)?.volume;
      if (this.connection !== connection || this.outputDeviceUID !== uid || this.mrpVolume !== undefined) return;
      if (!(typeof volume === 'number' && Number.isFinite(volume) && volume > 0 && volume <= 1)) return;
      this.mrpVolume = Math.round(volume * 1000) / 10;
      this.volume = this.mrpVolume;
      this.emit('volume', this.volume);
    })().catch(() => {}).finally(() => {
      if (this.connection === connection && this.mrpVolume === undefined) this.mrpVolumeRequested = false;
    });
  }

  /**
   * Turn volume updates off and on; tvOS then pushes the current capabilities, and an absolute one
   * lets requestMRPVolume() run. Asking for capabilities, or repeating `true`, reports nothing new.
   */
  private renewVolumeUpdates(): void {
    const connection = this.connection;
    if (!connection || !this.readyTransports.has(connection)) return;
    void (async () => {
      for (const volumeUpdates of [false, true]) {
        await connection.sendMRPMessage(await MRPMessage.clientUpdatesConfig({
          artworkUpdates: true, nowPlayingUpdates: true, volumeUpdates, keyboardUpdates: true,
        }));
      }
    })().catch(() => {});
  }

  /** Discard MRP runtime evidence when its transport session ends. */
  private resetRuntimeState(): void {
    this.playerState = new PlayerState();
    this.volumeAvailability = undefined;
    this.outputDeviceUID = undefined;
    this.mrpVolume = undefined;
    this.mrpVolumeRequested = false;
    this.nowPlaying = new NowPlayingInfo({ hasPlayback: false }, {});
    const companionReady = this.companionConnection && this.readyTransports.has(this.companionConnection);
    const nextVolume = companionReady ? this.companionVolume : undefined;
    if (this.volume !== nextVolume) {
      this.volume = nextVolume;
      if (nextVolume !== undefined) this.emit('volume', nextVolume);
    }
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
