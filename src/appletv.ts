import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PairSetup } from './auth/pair-setup.js';
import { AirPlayConnection } from './connection.js';
import { Credentials } from './credentials.js';
import { MRPMessage, HID_KEY_MAP, MessageType } from './mrp/messages.js';
import type { DiscoveredDeviceInfo } from './discovery.js';

export class AppleTV extends EventEmitter {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly deviceId: string;
  readonly model: string;
  private connection?: AirPlayConnection;
  private credentials?: Credentials;

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
    this.credentials = credentials;
    this.connection = new AirPlayConnection(this.address, this.port, credentials);
    this.connection.on('close', () => this.emit('close'));
    this.connection.on('error', (err) => this.emit('error', err));
    await this.connection.connect();
    this.emit('connect');
  }

  async close(): Promise<void> {
    this.connection?.close();
    this.connection = undefined;
  }

  // Remote control commands
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

  private async sendKey(key: string): Promise<void> {
    if (!this.connection) throw new Error('Not connected');

    // Media commands use SendCommandMessage instead of button events
    if (key === 'skip_forward') {
      const msg = await MRPMessage.sendMediaCommand(18); // SkipForward
      await this.connection.sendMRPMessage(msg);
      return;
    }
    if (key === 'skip_backward') {
      const msg = await MRPMessage.sendMediaCommand(19); // SkipBackward
      await this.connection.sendMRPMessage(msg);
      return;
    }

    // Button events via HID key map
    const baseKey = key === 'home_hold' ? 'home' : key;
    const hid = HID_KEY_MAP[baseKey];
    if (!hid) throw new Error(`Unknown key: ${key}`);

    const holdDuration = key === 'home_hold' ? 1000 : 50;

    // Button down
    const downMsg = await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, true);
    await this.connection.sendMRPMessage(downMsg);

    await delay(holdDuration);

    // Button up
    const upMsg = await MRPMessage.sendHIDEvent(hid.usagePage, hid.usage, false);
    await this.connection.sendMRPMessage(upMsg);

    // Flush — pyatv sends GENERIC_MESSAGE after HID events
    const flushMsg = await MRPMessage.sendCommand(MessageType.GenericMessage);
    await this.connection.sendMRPMessage(flushMsg);
  }

  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}
