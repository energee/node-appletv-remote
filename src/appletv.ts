/**
 * High-level Apple TV client. Wraps an AirPlay/MRP connection (remote keys,
 * media commands, text input, now-playing state) and an optional Companion
 * connection (apps, accounts, extra buttons, power state) behind one EventEmitter.
 */

import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PairSetup } from './auth/pair-setup.js';
import { AirPlayConnection } from './connection.js';
import { Credentials } from './credentials.js';
import { MRPMessage, HID_KEY_MAP, MessageType } from './mrp/messages.js';
import { NowPlayingInfo } from './now-playing-info.js';
import { SupportedCommand } from './supported-command.js';
import { Message } from './message.js';
import { CompanionConnection } from './companion/connection.js';
import { CompanionPairSetup } from './companion/pair-setup.js';
import type { OpackDict } from './companion/opack.js';
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
 * `playbackQueue`, `keyboard`, `textInput`, `volume`, `powerState`, `companionConnect`,
 * `companionClose`, `companionError`, `companionEvent`.
 */
export class AppleTV extends EventEmitter {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly deviceId: string;
  readonly model: string;
  readonly companionPort?: number;
  private connection?: AirPlayConnection;
  private companionConnection?: CompanionConnection;
  /** Output device for SetVolume, from the Apple TV's DeviceInfo reply (clusterID or deviceUID). */
  private outputDeviceUID?: string;
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
  }

  /** Begin AirPlay pair-setup; the Apple TV shows a PIN to pass to the returned PairSetup. */
  async startPairing(): Promise<PairSetup> {
    const ps = new PairSetup(this.address, this.port);
    await ps.start();
    return ps;
  }

  /** Open the AirPlay/MRP connection with stored credentials; emits `connect` once ready. */
  async connect(credentials: Credentials, options: ConnectOptions = {}): Promise<void> {
    this.connection = new AirPlayConnection(this.address, this.port, credentials, options.settleMs);
    this.connection.on('close', () => this.emit('close'));
    this.connection.on('error', (err) => this.emit('error', err));
    this.connection.on('mrp-message', (msg: Record<string, unknown>) => {
      this.handleMRPMessage(msg);
    });

    await this.connection.connect();
    this.emit('connect');
  }

  /** Close both the Companion and AirPlay connections, if open. */
  async close(): Promise<void> {
    this.companionConnection?.close();
    this.companionConnection = undefined;
    this.connection?.close();
    this.connection = undefined;
  }

  // --- Companion protocol ---

  /**
   * Begin Companion pair-setup; the Apple TV shows a PIN to pass to the returned CompanionPairSetup.
   * @throws If no Companion port was given or discovered.
   */
  async startCompanionPairing(options?: { companionPort?: number }): Promise<CompanionPairSetup> {
    const port = options?.companionPort ?? this.companionPort;
    if (!port) throw new Error('No companion port available');
    const ps = new CompanionPairSetup(this.address, port);
    await ps.start();
    return ps;
  }

  /**
   * Open the Companion connection; emits `companionConnect` once ready.
   * @throws If no Companion port was given or discovered.
   */
  async connectCompanion(credentials: HAPCredentials, companionPort?: number): Promise<void> {
    const port = companionPort ?? this.companionPort;
    if (!port) throw new Error('No companion port available');

    this.companionConnection = new CompanionConnection(this.address, port, credentials);
    this.companionConnection.on('close', () => this.emit('companionClose'));
    this.companionConnection.on('error', (err) => this.emit('companionError', err));
    this.companionConnection.on('event', (event: CompanionEvent) => {
      this.handleCompanionEvent(event);
    });

    await this.companionConnection.connect();
    this.emit('companionConnect');
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
  async channelUp(): Promise<void> { await this.companionButton(COMPANION_HID.channelUp); }
  async channelDown(): Promise<void> { await this.companionButton(COMPANION_HID.channelDown); }
  async screensaver(): Promise<void> { await this.companionButton(COMPANION_HID.screensaver); }
  async guide(): Promise<void> { await this.companionButton(COMPANION_HID.guide); }
  async pageUp(): Promise<void> { await this.companionButton(COMPANION_HID.pageUp); }
  async pageDown(): Promise<void> { await this.companionButton(COMPANION_HID.pageDown); }

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

  /** MRP HID remote buttons; each is a press, release and flush. */
  async up(): Promise<void> { await this.sendKey('up'); }
  async down(): Promise<void> { await this.sendKey('down'); }
  async left(): Promise<void> { await this.sendKey('left'); }
  async right(): Promise<void> { await this.sendKey('right'); }
  async select(): Promise<void> { await this.sendKey('select'); }
  async menu(): Promise<void> { await this.sendKey('menu'); }
  async home(): Promise<void> { await this.sendKey('home'); }
  /** Press Home and hold it for one second before releasing. */
  async homeHold(): Promise<void> { await this.sendKey('home', 1000); }
  async topMenu(): Promise<void> { await this.sendKey('top_menu'); }
  async playPause(): Promise<void> { await this.sendKey('play_pause'); }
  /** Skip forward; `seconds` overrides the app's default interval. */
  async skipForward(seconds?: number): Promise<void> {
    await this.sendMediaCommand(18, seconds ? { skipInterval: seconds } : undefined);
  }
  /** Skip backward; `seconds` overrides the app's default interval. */
  async skipBackward(seconds?: number): Promise<void> {
    await this.sendMediaCommand(19, seconds ? { skipInterval: seconds } : undefined);
  }
  async volumeUp(): Promise<void> { await this.sendKey('volume_up'); }
  async volumeDown(): Promise<void> { await this.sendKey('volume_down'); }

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

  /** Fetch current state as a SetState message (metadata for the first queue item). */
  async getState(): Promise<Record<string, unknown>> {
    // GetState (type=3) is unreliable over AirPlay transport.
    // Use PlaybackQueueRequest instead, which always returns a SetState response.
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
  async sendKeyCommand(key: Key): Promise<void> {
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
      default: return this.sendKey(key);
    }
  }

  // --- Internal ---

  /** @throws If connect() has not completed. */
  private requireConnection(): AirPlayConnection {
    if (!this.connection) throw new Error('Not connected');
    return this.connection;
  }

  /** Send an MRP SendCommand with optional CommandOptions fields. */
  private async sendMediaCommand(command: number, options?: Record<string, unknown>): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.sendMediaCommand(command, options);
    await conn.sendMRPMessage(msg);
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

  /** Press and release a Companion HID button (`_hBtS` 1 = down, 2 = up). */
  private async companionButton(code: number): Promise<void> {
    const conn = this.requireCompanion();
    await conn.sendRequest('_hidC', new Map([['_hBtS', 1], ['_hidC', code]]));
    await conn.sendRequest('_hidC', new Map([['_hBtS', 2], ['_hidC', code]]));
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

      const nowPlayingPayload = setState.nowPlayingInfo as
        | Record<string, unknown>
        | undefined;
      if (nowPlayingPayload) {
        const info = new NowPlayingInfo(setState, nowPlayingPayload);
        this.emit('nowPlaying', info);
      }

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

    // DeviceInfo (type 15): remember the output device for SetVolume (pyatv: clusterID or deviceUID)
    if (msg.type === MessageType.DeviceInfo) {
      const info = msg['.deviceInfoMessage'] as Record<string, unknown> | undefined;
      const uid = (info?.clusterID || info?.deviceUID) as string | undefined;
      if (uid) this.outputDeviceUID = uid;
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

  /** Press and release a HID_KEY_MAP button, holding it for `holdDuration` ms. */
  private async sendKey(key: string, holdDuration = 50): Promise<void> {
    const conn = this.requireConnection();
    const hid = HID_KEY_MAP[key];
    if (!hid) throw new Error(`Unknown key: ${key}`);

    const downMsg = await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, true);
    await conn.sendMRPMessage(downMsg);

    await delay(holdDuration);

    const upMsg = await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, false);
    await conn.sendMRPMessage(upMsg);

    // Flush -- pyatv sends GENERIC_MESSAGE after HID events
    const flushMsg = await MRPMessage.sendCommand(MessageType.GenericMessage);
    await conn.sendMRPMessage(flushMsg);
  }

  /** `name (address:port) [model]`. */
  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}
