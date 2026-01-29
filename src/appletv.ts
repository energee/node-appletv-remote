import { EventEmitter } from 'node:events';
import { PairSetup } from './auth/pair-setup.js';
import { AirPlayConnection } from './connection.js';
import { Credentials } from './credentials.js';
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
    // TODO: Map key to MRP protobuf command and send
  }

  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}
