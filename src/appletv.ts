import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PairSetup } from './auth/pair-setup.js';
import { AirPlayConnection } from './connection.js';
import { Credentials } from './credentials.js';
import { MRPMessage, HID_KEY_MAP, MessageType } from './mrp/messages.js';
import { NowPlayingInfo } from './now-playing-info.js';
import { SupportedCommand } from './supported-command.js';
import { Message } from './message.js';
import type { DiscoveredDeviceInfo } from './discovery.js';

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

export class AppleTV extends EventEmitter {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly deviceId: string;
  readonly model: string;
  private connection?: AirPlayConnection;

  constructor(info: DiscoveredDeviceInfo) {
    super();
    this.name = info.name;
    this.address = info.address;
    this.port = info.port;
    this.deviceId = info.deviceId;
    this.model = info.model;
  }

  /** Start pairing — displays PIN on Apple TV */
  async startPairing(): Promise<PairSetup> {
    const ps = new PairSetup(this.address, this.port);
    await ps.start();
    return ps;
  }

  /** Connect using stored credentials */
  async connect(credentials: Credentials): Promise<void> {
    this.connection = new AirPlayConnection(this.address, this.port, credentials);
    this.connection.on('close', () => this.emit('close'));
    this.connection.on('error', (err) => this.emit('error', err));
    this.connection.on('mrp-message', (msg: Record<string, unknown>) => {
      this.handleMRPMessage(msg);
    });

    await this.connection.connect();
    this.emit('connect');
  }

  async close(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
  }

  // --- Remote control commands ---

  async up(): Promise<void> { await this.sendKey('up'); }
  async down(): Promise<void> { await this.sendKey('down'); }
  async left(): Promise<void> { await this.sendKey('left'); }
  async right(): Promise<void> { await this.sendKey('right'); }
  async select(): Promise<void> { await this.sendKey('select'); }
  async menu(): Promise<void> { await this.sendKey('menu'); }
  async home(): Promise<void> { await this.sendKey('home'); }
  async homeHold(): Promise<void> { await this.sendKey('home_hold'); }
  async topMenu(): Promise<void> { await this.sendKey('top_menu'); }
  async playPause(): Promise<void> { await this.sendKey('play_pause'); }
  async skipForward(): Promise<void> { await this.sendKey('skip_forward'); }
  async skipBackward(): Promise<void> { await this.sendKey('skip_backward'); }
  async volumeUp(): Promise<void> { await this.sendKey('volume_up'); }
  async volumeDown(): Promise<void> { await this.sendKey('volume_down'); }

  // --- Media commands ---

  async play(): Promise<void> { await this.sendMediaCommand(1); }
  async pause(): Promise<void> { await this.sendMediaCommand(2); }
  async stop(): Promise<void> { await this.sendMediaCommand(4); }
  async next(): Promise<void> { await this.sendMediaCommand(5); }
  async previous(): Promise<void> { await this.sendMediaCommand(6); }

  // --- Device power ---

  async suspend(): Promise<void> {
    const conn = this.requireConnection();
    // Send HID suspend key (usagePage 1, usage 0x82 = SystemSleep)
    const downMsg = await MRPMessage.sendHIDEvent(1, 0x82, true);
    await conn.sendMRPMessage(downMsg);
    await delay(50);
    const upMsg = await MRPMessage.sendHIDEvent(1, 0x82, false);
    await conn.sendMRPMessage(upMsg);
  }

  async wake(): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.wakeDevice();
    await conn.sendMRPMessage(msg);
  }

  // --- State request ---

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
    const setState = response['.setStateMessage'] as
      | Record<string, unknown>
      | undefined;
    const queue = setState?.playbackQueue as
      | Record<string, unknown>
      | undefined;
    const items = queue?.contentItems as
      | Record<string, unknown>[]
      | undefined;
    if (items && items.length > 0) {
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

  async sendKeyCommand(key: Key): Promise<void> {
    switch (key) {
      case Key.Play: return this.play();
      case Key.Pause: return this.pause();
      case Key.Next: return this.next();
      case Key.Previous: return this.previous();
      case Key.Wake: return this.wake();
      case Key.Suspend: return this.suspend();
      default: return this.sendKey(key);
    }
  }

  // --- Internal ---

  private requireConnection(): AirPlayConnection {
    if (!this.connection) throw new Error('Not connected');
    return this.connection;
  }

  private async sendMediaCommand(command: number): Promise<void> {
    const conn = this.requireConnection();
    const msg = await MRPMessage.sendMediaCommand(command);
    await conn.sendMRPMessage(msg);
  }

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
  }

  private static readonly MEDIA_COMMAND_KEYS: Record<string, number> = {
    skip_forward: 18,
    skip_backward: 19,
  };

  private async sendKey(key: string): Promise<void> {
    const conn = this.requireConnection();

    // Some keys map to media commands instead of HID button events
    const mediaCommand = AppleTV.MEDIA_COMMAND_KEYS[key];
    if (mediaCommand !== undefined) {
      await this.sendMediaCommand(mediaCommand);
      return;
    }

    // Button events via HID key map
    const baseKey = key === 'home_hold' ? 'home' : key;
    const hid = HID_KEY_MAP[baseKey];
    if (!hid) throw new Error(`Unknown key: ${key}`);

    const holdDuration = key === 'home_hold' ? 1000 : 50;

    const downMsg = await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, true);
    await conn.sendMRPMessage(downMsg);

    await delay(holdDuration);

    const upMsg = await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, false);
    await conn.sendMRPMessage(upMsg);

    // Flush -- pyatv sends GENERIC_MESSAGE after HID events
    const flushMsg = await MRPMessage.sendCommand(MessageType.GenericMessage);
    await conn.sendMRPMessage(flushMsg);
  }

  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}
