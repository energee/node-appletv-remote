/** Deterministic operation routing over independently authenticated, caller-configured transports. */
import { EventEmitter } from 'node:events';
import { AppleTV, Key, PowerState, KeyboardFocusState, type Feature, type FeatureAvailability } from './appletv.js';
import { DmapClient } from './dmap/client.js';
import { Credentials } from './credentials.js';
import { NowPlayingInfo } from './now-playing-info.js';
import type { HAPCredentials } from './auth/types.js';
import type { DiscoveredDeviceInfo } from './discovery.js';

export type ControlProtocol = 'airplay' | 'mrp' | 'companion' | 'dmap';
/** Pairing carriers are deliberately separate, even when two use the same HAP key shape. */
export interface SessionCredentials {
  airplay?: HAPCredentials;
  mrp?: HAPCredentials;
  companion?: HAPCredentials;
  dmap?: string;
}

const MRP_OPERATIONS = [
  'up', 'down', 'left', 'right', 'select', 'menu', 'home', 'homeHold', 'topMenu', 'playPause',
  'play', 'pause', 'stop', 'next', 'previous', 'skipForward', 'skipBackward', 'volumeUp', 'volumeDown',
  'setPosition', 'setShuffle', 'setRepeat', 'setVolume', 'wake', 'suspend', 'deleteText',
  'getNowPlaying', 'getState', 'requestPlaybackQueue', 'requestArtwork',
  'addOutputDevices', 'removeOutputDevices', 'setOutputDevices',
] as const;
const COMPANION_OPERATIONS = [
  'up', 'down', 'left', 'right', 'select', 'menu', 'home', 'homeHold', 'playPause',
  'play', 'pause', 'next', 'previous', 'skipForward', 'skipBackward', 'volumeUp', 'volumeDown',
  'setVolume', 'wake', 'suspend', 'setText', 'insertText', 'clearText', 'getText', 'fetchTextFocusState',
  'appList', 'launchApp', 'accountList', 'switchAccount', 'fetchPowerState', 'subscribePowerState',
  'channelUp', 'channelDown', 'screensaver', 'guide', 'pageUp', 'pageDown', 'click', 'swipe',
  'touchAction', 'stopTouch', 'sendCompanionRequest', 'sendCompanionMessage',
] as const;
const DMAP_OPERATIONS = [
  'up', 'down', 'left', 'right', 'select', 'menu', 'topMenu', 'playPause', 'play', 'pause', 'stop',
  'next', 'previous', 'skipForward', 'skipBackward', 'volumeUp', 'volumeDown', 'setPosition',
  'setShuffle', 'setRepeat', 'getNowPlaying', 'requestArtwork',
] as const;
export type SessionOperation = typeof MRP_OPERATIONS[number] | typeof COMPANION_OPERATIONS[number];
type OperationMethod<K extends SessionOperation> = AppleTV[K] extends (...args: infer A) => infer R ? (...args: A) => R : never;

/** Public key-to-operation policy, shared by interactive and one-shot consumers. */
export const KEY_OPERATIONS: Readonly<Record<Key, SessionOperation>> = {
  [Key.Up]: 'up', [Key.Down]: 'down', [Key.Left]: 'left', [Key.Right]: 'right', [Key.Select]: 'select',
  [Key.Menu]: 'menu', [Key.Home]: 'home', [Key.HomeHold]: 'homeHold', [Key.TopMenu]: 'topMenu',
  [Key.PlayPause]: 'playPause', [Key.Play]: 'play', [Key.Pause]: 'pause', [Key.Next]: 'next', [Key.Previous]: 'previous',
  [Key.SkipForward]: 'skipForward', [Key.SkipBackward]: 'skipBackward', [Key.VolumeUp]: 'volumeUp',
  [Key.VolumeDown]: 'volumeDown', [Key.Suspend]: 'suspend', [Key.Wake]: 'wake',
};
export interface SessionOptions {
  credentials: SessionCredentials;
  /** Omitted: open every eligible transport with its own credentials. Explicit entries default to required. */
  transports?: Partial<Record<ControlProtocol, { required?: boolean }>>;
  /** Limit setup to providers selected for these operations; useful for one-shot consumers. */
  operations?: readonly SessionOperation[];
  /** An override is strict: no alternative provider is selected if this provider is unavailable. */
  preferences?: Partial<Record<SessionOperation, ControlProtocol>>;
  settleMs?: number;
}
export interface SessionConnectionEvent {
  protocol: ControlProtocol;
  state: 'ready' | 'lost' | 'closed' | 'failed';
  /** Setup errors are observable for optional transports; never imply that their features are ready. */
  error?: Error;
}

type Provider = { protocol: ControlProtocol; client: AppleTV | DmapClient; ready: boolean; required: boolean; closed: boolean; snapshot?: NowPlayingInfo; detach: () => void };
const implementations: Record<ControlProtocol, readonly SessionOperation[]> = {
  airplay: MRP_OPERATIONS, mrp: MRP_OPERATIONS,
  companion: COMPANION_OPERATIONS, dmap: DMAP_OPERATIONS,
};
const companionFirst: Partial<Record<SessionOperation, true>> = Object.fromEntries([
  ...COMPANION_OPERATIONS.filter(operation => !MRP_OPERATIONS.includes(operation as typeof MRP_OPERATIONS[number])),
  'wake', 'suspend',
].map(operation => [operation, true]));
const operationFeatures: Partial<Record<SessionOperation, Feature>> = {
  getNowPlaying: 'getState', getState: 'getState', requestPlaybackQueue: 'getState', requestArtwork: 'requestArtwork',
  insertText: 'setText', clearText: 'setText', getText: 'setText',
};
/**
 * One session, separate protocol credentials and clients, no action replay or reconnect.
 * Events: connection, ready, close, transportError, nowPlaying, volume, powerState,
 * textFocusState, outputDevices, featureAvailability, keyboard, textInput, message, companionEvent.
 * State events have exactly one authoritative provider. Create listeners before connect().
 */
export class DeviceSession extends EventEmitter {
  private state: 'new' | 'connecting' | 'ready' | 'closed' = 'new';
  private generation = 0;
  private providers = new Map<ControlProtocol, Provider>();
  private readonly configured: ControlProtocol[];
  private readonly preferences: Partial<Record<SessionOperation, ControlProtocol>>;
  private readonly credentials: SessionCredentials;
  private readonly requirements: Partial<Record<ControlProtocol, { required?: boolean }>>;
  private readonly settleMs?: number;
  private closePromise?: Promise<void>;
  private lastPrimitiveState: Record<string, unknown> = {};

  constructor(readonly device: DiscoveredDeviceInfo, options: SessionOptions) {
    super();
    this.credentials = { ...options.credentials };
    this.preferences = { ...options.preferences };
    this.requirements = options.transports ?? {};
    this.settleMs = options.settleMs;
    const explicit = options.transports !== undefined;
    const protocols: ControlProtocol[] = ['airplay', 'mrp', 'companion', 'dmap'];
    this.configured = protocols.filter(protocol => explicit ? Object.hasOwn(options.transports!, protocol) :
      this.credentials[protocol] !== undefined && this.endpointEligible(protocol));
    if (!this.configured.length) throw new Error('No usable configured control transport');
    for (const protocol of this.configured) {
      if (this.credentials[protocol] === undefined) throw new Error(`Missing ${protocol} credentials`);
      if (!this.endpointEligible(protocol)) throw new Error(`No eligible ${protocol} endpoint`);
    }
    for (const [operation, protocol] of Object.entries(this.preferences)) {
      if (!protocols.includes(protocol!) || !implementations[protocol!]?.includes(operation as SessionOperation)) {
        throw new Error(`Operation ${operation} is not implemented by ${protocol}`);
      }
      if (!this.configured.includes(protocol!)) throw new Error(`Preferred ${protocol} transport is not configured`);
    }
    if (options.operations) {
      const selected = new Set<ControlProtocol>();
      for (const operation of options.operations) {
        const protocol = this.candidates(operation).find(protocol => this.configured.includes(protocol));
        if (!protocol) throw new Error(`No configured implementation for ${operation}`);
        selected.add(protocol);
      }
      this.configured = this.configured.filter(protocol => selected.has(protocol));
      if (!this.configured.length) throw new Error('At least one operation is required');
    }
  }

  private endpointEligible(protocol: ControlProtocol): boolean {
    switch (protocol) {
      case 'airplay': return !!this.device.port && !/^AppleTV[1-3],/.test(this.device.model);
      case 'mrp': return !!this.device.mrpPort && this.device.mrpEnabled !== false;
      case 'companion': return !!this.device.companionPort;
      case 'dmap': return !!this.device.dmapPort;
    }
  }

  private candidates(operation: SessionOperation): ControlProtocol[] {
    const override = this.preferences[operation];
    if (override) return [override];
    const ordered: ControlProtocol[] = companionFirst[operation]
      ? ['companion', 'airplay', 'mrp', 'dmap'] : ['airplay', 'mrp', 'companion', 'dmap'];
    return ordered.filter(protocol => implementations[protocol].includes(operation));
  }

  /** Reject concurrent/repeated setup; a session is single-use. Required failure closes the whole attempt. */
  async connect(): Promise<void> {
    if (this.state !== 'new') throw new Error(`Session cannot connect while ${this.state}`);
    this.state = 'connecting';
    const generation = ++this.generation;
    try {
      for (const protocol of this.configured) {
        if (generation !== this.generation) throw new Error('Session closed during setup');
        const client = protocol === 'dmap' ? new DmapClient(this.device) :
          new AppleTV({ ...this.device, port: protocol === 'mrp' || protocol === 'companion' ? 0 : this.device.port });
        const provider: Provider = { protocol, client, ready: false, closed: false,
          required: this.requirements[protocol]?.required !== false, detach: () => {} };
        this.providers.set(protocol, provider);
        this.observe(provider);
        try {
          if (client instanceof DmapClient) await client.connect(this.credentials.dmap!);
          else if (protocol === 'companion') await client.connectCompanion(this.credentials.companion!);
          else await client.connect(new Credentials(this.credentials[protocol] as HAPCredentials), { settleMs: this.settleMs });
          if (generation !== this.generation || this.providers.get(protocol) !== provider) throw new Error('Session closed during setup');
          provider.ready = true;
          this.emit('connection', { protocol, state: 'ready' } satisfies SessionConnectionEvent);
        } catch (cause) {
          provider.ready = false;
          provider.detach();
          if (!provider.closed) { provider.closed = true; await client.close(); }
          if (generation !== this.generation) throw new Error('Session closed during setup');
          this.providers.delete(protocol);
          if (provider.required) throw cause;
          const error = cause instanceof Error ? cause : new Error('Transport setup failed');
          this.emit('connection', { protocol, state: 'failed', error } satisfies SessionConnectionEvent);
          this.emit('transportError', { protocol, error });
        }
      }
      if (!Array.from(this.providers.values()).some(provider => provider.ready)) throw new Error('No control transport became ready');
      this.state = 'ready';
      this.emit('ready');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private observe(provider: Provider): void {
    const { client, protocol } = provider;
    const listeners: Array<[string, (...args: unknown[]) => void]> = [];
    const listen = (event: string, handler: (...args: unknown[]) => void) => { client.on(event, handler); listeners.push([event, handler]); };
    const current = () => this.providers.get(protocol) === provider && this.state !== 'closed' &&
      (provider.ready || this.state === 'connecting');
    const loss = (error?: Error) => {
      if (!current() || !provider.ready) return;
      const ownedState = {
        playback: this.authority('getNowPlaying') === provider,
        volume: this.authority('setVolume') === provider,
        outputs: this.authority('requestPlaybackQueue') === provider,
        power: this.authority('fetchPowerState') === provider,
        focus: this.authority('fetchTextFocusState') === provider,
      };
      provider.ready = false;
      provider.closed = true;
      provider.snapshot = undefined;
      provider.detach();
      this.emit('connection', { protocol, state: 'lost', ...(error ? { error } : {}) } satisfies SessionConnectionEvent);
      this.emit('featureAvailability');
      // Invalidate rather than retain a lost provider's snapshots as live state.
      if (ownedState.power) this.publish('powerState', this.powerState);
      if (ownedState.focus) this.publish('textFocusState', this.textFocusState);
      if (ownedState.playback) this.publish('nowPlaying', this.nowPlaying);
      if (ownedState.volume) this.publish('volume', this.volume);
      if (ownedState.outputs) this.publish('outputDevices', this.outputDevices);
    };
    listen(protocol === 'companion' ? 'companionClose' : 'close', () => loss());
    listen(protocol === 'companion' ? 'companionError' : 'error', (error: unknown) => {
      if (current()) this.emit('transportError', { protocol, error });
    });
    if (protocol === 'dmap') listen('pushError', (cause: unknown) => {
      loss(cause instanceof Error ? cause : new Error('DMAP push connection lost'));
      void client.close();
    });
    const states: Record<string, SessionOperation> = {
      nowPlaying: 'getNowPlaying', volume: 'setVolume', outputDevices: 'requestPlaybackQueue',
      powerState: 'fetchPowerState', textFocusState: 'fetchTextFocusState', keyboard: 'getState', textInput: 'getState',
    };
    for (const [event, operation] of Object.entries(states)) listen(event, (...args) => {
      if (event === 'nowPlaying' && args[0] instanceof NowPlayingInfo) provider.snapshot = args[0];
      // Setup pushes precede ready. They may be published but never treated as a ready action provider.
      if (current() && this.authority(operation)?.protocol === protocol) this.publish(event, args[0]);
    });
    for (const event of ['message', 'companionEvent', 'featureAvailability']) listen(event, (...args) => {
      if (current()) this.emit(event, ...args);
    });
    provider.detach = () => { for (const [event, handler] of listeners) client.removeListener(event, handler); };
  }

  private publish(event: string, value: unknown): void {
    if (event === 'powerState' || event === 'textFocusState' || event === 'volume') {
      if (Object.hasOwn(this.lastPrimitiveState, event) && this.lastPrimitiveState[event] === value) return;
      this.lastPrimitiveState[event] = value;
    }
    this.emit(event, value);
  }

  private authority(operation: SessionOperation): Provider | undefined {
    for (const protocol of this.candidates(operation)) {
      const provider = this.providers.get(protocol);
      if (provider && (provider.ready || this.state === 'connecting') &&
          (!provider.ready || !['unsupported', 'unavailable'].includes(this.availability(provider, operation)))) return provider;
    }
    return undefined;
  }

  private availability(provider: Provider, operation: SessionOperation): FeatureAvailability {
    if (!provider.ready) return 'unavailable';
    if (provider.client instanceof DmapClient) {
      const capability = operation === 'getNowPlaying' ? 'unknown' : provider.client.capabilities()[operation] ?? 'unknown';
      return capability === 'available' ? 'supported' : capability;
    }
    return provider.client.featureAvailability(operationFeatures[operation] ?? operation as Feature);
  }

  /** Implementation support is distinct from device evidence; unknown does not mean unsupported. */
  featureAvailability(operation: SessionOperation): FeatureAvailability {
    const provider = this.select(operation, false);
    if (provider) return this.availability(provider, operation);
    const candidates = this.candidates(operation).filter(protocol => this.configured.includes(protocol));
    if (!candidates.length) return 'unsupported';
    return candidates.every(protocol => {
      const candidate = this.providers.get(protocol);
      return candidate?.ready && this.availability(candidate, operation) === 'unsupported';
    }) ? 'unsupported' : 'unavailable';
  }

  private select(operation: SessionOperation, required = true): Provider | undefined {
    for (const protocol of this.candidates(operation)) {
      const provider = this.providers.get(protocol);
      if (!provider?.ready) continue;
      const evidence = this.availability(provider, operation);
      if (evidence !== 'unsupported' && evidence !== 'unavailable') return provider;
    }
    if (required) throw new Error(`No usable control transport for ${operation}`);
    return undefined;
  }

  /** Select exactly once before dispatch. Any post-dispatch error is propagated without replay. */
  async execute<K extends SessionOperation>(operation: K, ...args: Parameters<OperationMethod<K>>): Promise<Awaited<ReturnType<OperationMethod<K>>>> {
    if (this.state !== 'ready') throw new Error('Session is not ready');
    const provider = this.select(operation)!;
    if (!implementations[provider.protocol].includes(operation)) throw new Error(`No implementation for ${operation}`);
    const method = provider.client instanceof DmapClient && operation === 'getNowPlaying' ? 'getState' : operation;
    // The implementation table establishes that this in-process method exists; heterogeneous signatures require erasure at dispatch only.
    const callable = (provider.client as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
    const result = await callable.apply(provider.client, args);
    if (provider.client instanceof DmapClient && operation === 'getNowPlaying' && result instanceof NowPlayingInfo && this.providers.get(provider.protocol) === provider && provider.ready) {
      provider.snapshot = result;
      if (this.authority(operation) === provider) this.emit('nowPlaying', result);
    }
    return result as Awaited<ReturnType<OperationMethod<K>>>;
  }

  /** Key names use the same operation policy as their direct public methods. */
  async sendKeyCommand(key: Key, action?: Parameters<AppleTV['sendKeyCommand']>[1]): Promise<void> {
    if (this.state !== 'ready') throw new Error('Session is not ready');
    const operation = KEY_OPERATIONS[key];
    if (!operation) throw new Error('Unsupported key');
    const provider = this.select(operation)!;
    if (provider.client instanceof DmapClient) {
      if (action !== undefined && action !== 'singleTap') throw new Error('DMAP does not support input action modes');
      // DMAP has no action modes; every key here maps to one of its declared no-argument controls.
      const controls = provider.client as unknown as Record<string, () => Promise<void>>;
      await controls[operation]();
    } else await provider.client.sendKeyCommand(key, action);
  }

  get nowPlaying(): NowPlayingInfo {
    const provider = this.authority('getNowPlaying');
    return provider?.client instanceof AppleTV ? provider.client.nowPlaying : provider?.snapshot ?? new NowPlayingInfo({ hasPlayback: false }, {});
  }
  get volume(): number | undefined { const provider = this.authority('setVolume'); return provider?.client instanceof AppleTV ? provider.client.volume : undefined; }
  get outputDevices() { const provider = this.authority('requestPlaybackQueue'); return provider?.client instanceof AppleTV ? provider.client.outputDevices : []; }
  get powerState(): PowerState { const provider = this.authority('fetchPowerState'); return provider?.client instanceof AppleTV ? provider.client.powerState : PowerState.Unknown; }
  get textFocusState(): KeyboardFocusState { const provider = this.authority('fetchTextFocusState'); return provider?.client instanceof AppleTV ? provider.client.textFocusState : KeyboardFocusState.Unknown; }

  /** Idempotent cancellation, including in-flight setup; detach before closing to reject late callbacks. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = 'closed';
    this.generation++;
    const providers = [...this.providers.values()];
    this.providers.clear();
    for (const provider of providers) provider.detach();
    this.closePromise = (async () => {
      await Promise.all(providers.map(async provider => {
        const wasReady = provider.ready;
        provider.ready = false;
        if (!provider.closed) { provider.closed = true; await provider.client.close(); }
        if (wasReady) this.emit('connection', { protocol: provider.protocol, state: 'closed' } satisfies SessionConnectionEvent);
      }));
      this.emit('close');
    })();
    return this.closePromise;
  }
}

/** Configure listeners before awaiting connect by constructing DeviceSession directly when initial events matter. */
export async function connectDevice(device: DiscoveredDeviceInfo, options: SessionOptions): Promise<DeviceSession> {
  const session = new DeviceSession(device, options);
  await session.connect();
  return session;
}
