/** Shared MRP handshake, UUID response correlation, and lifecycle-safe message delivery. */
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { MRPMessage, MessageType } from './messages.js';
import type { HAPCredentials } from '../auth/types.js';

/** Common protocol state for AirPlay-tunneled and standalone MRP transports. */
export abstract class MRPConnection extends EventEmitter {
  protected closed = false;
  protected mrpGeneration = 0;
  protected pendingMRPResolvers: Array<{
    /** Undefined matches any type (identifier-only correlation, as pyatv send_and_receive). */
    type?: number;
    identifier?: string;
    reject: (err: Error) => void;
    resolve: (msg: Record<string, unknown>) => void;
  }> = [];
  constructor(protected credentials: HAPCredentials, protected settleMs = 0) { super(); }
  protected log(_message: string): void {}
  protected async authenticateMRP(): Promise<void> {}
  abstract connect(): Promise<void>;
  abstract close(): void;
  abstract sendMRPMessage(data: Buffer): Promise<void>;
  /**
   * MRP handshake on the data channel: DeviceInfo (awaits the reply), SetConnectionState,
   * ClientUpdatesConfig, GetKeyboardSession, then the optional `settleMs` delay (default 0).
   * @throws if the DeviceInfo reply does not arrive within 5 s.
   */
  protected async initMRPProtocol(): Promise<void> {
    this.log('sending DeviceInfo...');

    // 1. DeviceInfo must be the first message
    const deviceInfo = await MRPMessage.deviceInfo({
      uniqueIdentifier: this.credentials.clientId,
      name: 'Node ATV Remote',
    });
    // DeviceInfo can be unsolicited/identifierless; install its type waiter before writing.
    const response = this.waitForMRPMessage(MessageType.DeviceInfo, 5000);
    void this.sendMRPMessage(deviceInfo).catch(err => this.rejectMRPRequests(err));
    await response;
    await this.authenticateMRP();
    this.log('DeviceInfo exchange complete');

    // AirPlay is already HAP encrypted; standalone MRP verifies in authenticateMRP.

    // 3. SetConnectionState (fire and forget, pyatv uses send() not send_and_receive())
    const connState = await MRPMessage.setConnectionState(2);
    await this.sendMRPMessage(connState);

    // 4. ClientUpdatesConfig (pyatv waits for a reply; we only send)
    const updatesConfig = await MRPMessage.clientUpdatesConfig({
      artworkUpdates: true,
      nowPlayingUpdates: true,
      volumeUpdates: true,
      keyboardUpdates: true,
    });
    await this.sendMRPMessage(updatesConfig);

    // 5. GetKeyboardSession (pyatv waits for a reply; we only send)
    const getKeyboard = await MRPMessage.sendCommand(MessageType.GetKeyboardSession);
    await this.sendMRPMessage(getKeyboard);

    // ponytail: fixed settle, 0 by default (was 500 ms). Replace with waiting for the first
    // update message if some Apple TV model turns out to drop the first command.
    if (this.settleMs > 0) await delay(this.settleMs);
  }

  /**
   * Resolve with the next MRP message of `type` from the data channel.
   * @throws (rejects) after `timeoutMs` with no matching message.
   */
  protected waitForMRPMessage(type: number | undefined, timeoutMs = 5000, identifier?: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Connection closed')); return; }
      const remove = (): void => {
        clearTimeout(timer);
        const idx = this.pendingMRPResolvers.indexOf(entry);
        if (idx >= 0) this.pendingMRPResolvers.splice(idx, 1);
      };
      const entry = {
        type, identifier,
        resolve: (msg: Record<string, unknown>): void => { remove(); resolve(msg); },
        reject: (err: Error): void => { remove(); reject(err); },
      };
      const timer = setTimeout(() => entry.reject(new Error(`Timeout waiting for MRP message type ${type ?? 'any'}`)), timeoutMs);
      this.pendingMRPResolvers.push(entry);
    });
  }

  /**
   * Decode an MRP protobuf, emit it as `mrp-message`, and match request UUID plus type.
   * Separate handshake waiters accept unsolicited messages of their expected type. Stale session decodes are discarded; only decode errors are logged, while listener exceptions propagate.
   */
  protected async handleMRPResponse(protobufData: Buffer): Promise<void> {
    const generation = this.mrpGeneration;
    let msg: Record<string, unknown>;
    try {
      msg = await MRPMessage.decode(protobufData);
    } catch (e) {
      this.log(`MRP decode error: ${e}`);
      return;
    }
    if (this.closed || generation !== this.mrpGeneration) return;
    this.log(`MRP response: type=${msg.type}`);
    // Normalize pushed state before the corresponding request resumes. Listener errors are not decode errors.
    try {
      this.emit('mrp-message', msg);
    } finally {
      if (!this.closed && generation === this.mrpGeneration) {
        const idx = this.pendingMRPResolvers.findIndex(
          (r) => (r.type === undefined || r.type === msg.type) && (r.identifier === undefined || r.identifier === msg.identifier),
        );
        if (idx >= 0) this.pendingMRPResolvers.splice(idx, 1)[0].resolve(msg);
      }
    }
  }

  /**
   * Send an MRP message and match its existing UUID plus `responseType` (undefined: any type).
   * The waiter is registered before sending so a fast reply is not missed.
   */
  async sendMRPMessageAndWait(
    protobufData: Buffer,
    responseType: number | undefined,
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    const identifier = (await MRPMessage.decode(protobufData)).identifier;
    if (typeof identifier !== 'string' || !identifier) throw new Error('MRP request requires an identifier');
    if (this.pendingMRPResolvers.some(entry => entry.identifier === identifier)) throw new Error('MRP identifier already pending');
    const waitPromise = this.waitForMRPMessage(responseType, timeoutMs, identifier);
    // Handle send failure through the same waiter so no orphan rejection/timer survives.
    void this.sendMRPMessage(protobufData).catch(err => {
      this.pendingMRPResolvers.find(entry => entry.identifier === identifier)?.reject(err);
    });
    return waitPromise;
  }

  /** Reject all waiters and release their timers on transport loss. */
  protected rejectMRPRequests(error: Error): void {
    for (const entry of [...this.pendingMRPResolvers]) entry.reject(error);
  }
}
