/** Shared MRP handshake, UUID response correlation, and lifecycle-safe message delivery. */
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { MRPMessage, MessageType, PLAYER_STATE_FIELDS } from './messages.js';
import type { HAPCredentials } from '../auth/types.js';

/** Sanitized issue #10 trace. Identifiers are opaque, connection-local tokens, never raw device/media IDs. */
export interface MRPDiagnostic {
  direction: 'send' | 'receive';
  type: number;
  identifier?: string;
  client?: string;
  player?: string;
  /** Receive only: whether type and identifier match a pending request before message delivery. */
  matchedRequest?: boolean;
}

/** MRP envelope error "Could not find the specified now playing client": nothing is playing (#10). */
export const MRP_ERROR_NO_NOW_PLAYING_CLIENT = 35;

/** A device error reply to a request: `errorCode` is the ProtocolMessage envelope code. */
export type MRPReplyError = Error & { errorCode: number };

/** True for an envelope that reports a nonzero `errorCode`. */
function isErrorReply(msg: Record<string, unknown>): boolean {
  return typeof msg.errorCode === 'number' && msg.errorCode !== 0;
}

function mrpReplyError(msg: Record<string, unknown>): MRPReplyError {
  const errorCode = msg.errorCode as number;
  return Object.assign(new Error(`MRP request failed: errorCode=${errorCode} ${(msg.errorDescription as string | undefined) ?? ''}`.trim()), { errorCode });
}

/** Common protocol state for AirPlay-tunneled and standalone MRP transports. */
export abstract class MRPConnection extends EventEmitter {
  protected closed = false;
  protected mrpGeneration = 0;
  /** In-memory equality tokens, capped at the 1024 most recently used values (LRU); discarded with this connection, never persisted. */
  private diagnosticIds = new Map<string, string>();
  private diagnosticCount = 0;
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
    await this.diagnoseSend(deviceInfo);
    void this.sendMRPMessage(deviceInfo).catch(err => this.rejectMRPRequests(err));
    await response;
    await this.authenticateMRP();
    this.log('DeviceInfo exchange complete');

    // AirPlay is already HAP encrypted; standalone MRP verifies in authenticateMRP.

    // 3. SetConnectionState (fire and forget, pyatv uses send() not send_and_receive())
    const connState = await MRPMessage.setConnectionState(2);
    await this.diagnoseSend(connState);
    await this.sendMRPMessage(connState);

    // 4. ClientUpdatesConfig (pyatv waits for a reply; we only send)
    const updatesConfig = await MRPMessage.clientUpdatesConfig({
      artworkUpdates: true,
      nowPlayingUpdates: true,
      volumeUpdates: true,
      keyboardUpdates: true,
    });
    await this.diagnoseSend(updatesConfig);
    await this.sendMRPMessage(updatesConfig);

    // 5. GetKeyboardSession (pyatv waits for a reply; we only send)
    const getKeyboard = await MRPMessage.sendCommand(MessageType.GetKeyboardSession);
    await this.diagnoseSend(getKeyboard);
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
   * Decode an MRP protobuf, emit it as `mrp-message`, and resolve the first waiter whose identifier and type (each only if set) match.
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
      this.emitDiagnostic('receive', msg);
      this.emit('mrp-message', msg);
    } finally {
      if (!this.closed && generation === this.mrpGeneration) {
        const idx = this.pendingMRPResolvers.findIndex(entry => this.matchesWaiter(entry, msg));
        if (idx >= 0) {
          const entry = this.pendingMRPResolvers.splice(idx, 1)[0];
          // Untyped waiters (media commands) inspect the envelope themselves; typed ones get a rejection.
          if (entry.type !== undefined && isErrorReply(msg)) entry.reject(mrpReplyError(msg));
          else entry.resolve(msg);
        }
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
    const request = await MRPMessage.decode(protobufData);
    const identifier = request.identifier;
    if (typeof identifier !== 'string' || !identifier) throw new Error('MRP request requires an identifier');
    if (this.pendingMRPResolvers.some(entry => entry.identifier === identifier)) throw new Error('MRP identifier already pending');
    const waitPromise = this.waitForMRPMessage(responseType, timeoutMs, identifier);
    // Handle send failure through the same waiter so no orphan rejection/timer survives.
    void (async () => {
      this.emitDiagnostic('send', request);
      await this.sendMRPMessage(protobufData);
    })().catch(err => {
      this.pendingMRPResolvers.find(entry => entry.identifier === identifier)?.reject(err);
    });
    return waitPromise;
  }

  /** Emit a send diagnostic for an encoded message, decoding it only when observed. */
  private async diagnoseSend(protobufData: Buffer): Promise<void> {
    if (this.listenerCount('mrp-diagnostic')) this.emitDiagnostic('send', await MRPMessage.decode(protobufData));
  }

  /** Emit only the init/state routing fields needed for #10, and only when observed. Never copy payloads. */
  private emitDiagnostic(direction: MRPDiagnostic['direction'], msg: Record<string, unknown>): void {
    if (!this.listenerCount('mrp-diagnostic') || !Object.prototype.hasOwnProperty.call(msg, 'type')) return;
    const type = msg.type as MessageType;
    const field = PLAYER_STATE_FIELDS[type] ?? (type === MessageType.PlaybackQueueRequest ? '.playbackQueueRequestMessage' :
      [MessageType.DeviceInfo, MessageType.ClientUpdatesConfig, MessageType.GetKeyboardSession, MessageType.SetConnectionState].includes(type) ? '' : undefined);
    if (field === undefined) return;
    const diagnostic: MRPDiagnostic = { direction, type };
    const token = (kind: string, value: unknown): string | undefined => {
      if (typeof value !== 'string' || !value) return undefined;
      const key = JSON.stringify([kind, value]);
      // LRU: re-insert on every use so long-lived client/player tokens outlive churning request ids.
      const id = this.diagnosticIds.get(key) ?? `${kind}-${++this.diagnosticCount}`;
      this.diagnosticIds.delete(key);
      this.diagnosticIds.set(key, id);
      if (this.diagnosticIds.size > 1024) this.diagnosticIds.delete(this.diagnosticIds.keys().next().value!);
      return id;
    };
    const identifier = token('request', msg.identifier);
    if (identifier) diagnostic.identifier = identifier;
    const payload = msg[field] as { client?: { bundleIdentifier?: string }; playerPath?: { client?: { bundleIdentifier?: string }; player?: { identifier?: string } } } | undefined;
    const client = token('client', payload?.client?.bundleIdentifier ?? payload?.playerPath?.client?.bundleIdentifier);
    const player = token('player', payload?.playerPath?.player?.identifier);
    if (client) diagnostic.client = client;
    if (player) diagnostic.player = player;
    if (direction === 'receive') diagnostic.matchedRequest = this.pendingMRPResolvers.some(entry => this.matchesWaiter(entry, msg));
    try { this.emit('mrp-diagnostic', diagnostic); }
    catch { this.log('MRP diagnostic observer failed'); }
  }

  /**
   * A waiter matches when its type (if set) and identifier (if set) equal the message's.
   * A typed request waiter also matches a same-identifier reply with a nonzero `errorCode`, which
   * the device sends without a type; `handleMRPResponse` rejects it (#10).
   */
  protected matchesWaiter(entry: { type?: number; identifier?: string }, msg: Record<string, unknown>): boolean {
    if (entry.identifier !== undefined && entry.identifier !== msg.identifier) return false;
    return entry.type === undefined || entry.type === msg.type || (entry.identifier !== undefined && isErrorReply(msg));
  }

  /**
   * Deliver one message unless its session (captured as `generation` when it was queued) closed meanwhile.
   * Listener exceptions surface as uncaught exceptions, not detached rejections.
   */
  protected async deliverMRP(message: Buffer, generation = this.mrpGeneration): Promise<void> {
    if (this.closed || generation !== this.mrpGeneration) return;
    try { await this.handleMRPResponse(message); } catch (error) { queueMicrotask(() => { throw error; }); }
  }

  /** Reject all waiters and release their timers on transport loss. */
  protected rejectMRPRequests(error: Error): void {
    for (const entry of [...this.pendingMRPResolvers]) entry.reject(error);
  }
}
