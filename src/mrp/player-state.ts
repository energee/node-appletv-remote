/** Player-scoped MRP snapshots; follows pyatv v0.18.0 player_state.py field-presence semantics. */
import { NowPlayingInfo } from '../now-playing-info.js';
import { SupportedCommand } from '../supported-command.js';
import { MessageType } from './messages.js';

type Payload = Record<string, any>;
interface Player {
  /** Only the SetState fields snapshot() reads (playbackState, displayName); never queue/artwork payloads. */
  state: Payload;
  direct: Payload;
  items: Payload[];
  location: number;
  commands?: SupportedCommand[];
}
interface Client {
  info: Payload;
  players: Map<string, Player>;
  active?: string | null;
  commands?: SupportedCommand[];
}
const DEFAULT_PLAYER = 'MediaRemote-DefaultPlayer';

/** Keeps inactive-player updates separate until the device selects that client/player. */
export class PlayerState {
  private clients = new Map<string, Client>();
  private activeClient?: string;
  private selected = false;
  private routingSelected = false;

  /** Current active-player commands; undefined means no advertisement has arrived. */
  get commands(): SupportedCommand[] | undefined {
    const client = this.activeClient === undefined ? undefined : this.clients.get(this.activeClient);
    const player = client?.active === null ? undefined : client?.players.get(client.active ?? DEFAULT_PLAYER);
    if (!player?.commands) return client?.commands;
    return [...player.commands, ...(client?.commands ?? []).filter(cmd => !player.commands!.some(p => p.command === cmd.command))];
  }

  /**
   * Cache bypass requires a device routing selection, not the legacy first-state fallback.
   * A selected empty client (idle TV) is itself a definitive nothing-playing snapshot.
   */
  get hasSelectedSnapshot(): boolean {
    return this.routingSelected && (this.hasSnapshot || this.activeClient === '');
  }

  /** Received state for the model's current player (also the legacy first-state fallback). Identity/commands alone are not state. */
  get hasSnapshot(): boolean {
    const client = this.activeClient === undefined ? undefined : this.clients.get(this.activeClient);
    const player = client?.active === null ? undefined : client?.players.get(client.active ?? DEFAULT_PLAYER);
    return !!player && (typeof player.state.playbackState === 'number' ||
      player.state.playbackQueue !== undefined || Object.keys(player.direct).length > 0);
  }

  /** Fresh normalized snapshot without position extrapolation. */
  snapshot(): NowPlayingInfo {
    const client = this.activeClient === undefined ? undefined : this.clients.get(this.activeClient);
    const identifier = client?.active ?? DEFAULT_PLAYER;
    const player = client?.active === null ? undefined : client?.players.get(identifier);
    const metadata = player?.items[player.location]?.metadata;
    const normalized: Payload = {};
    if (metadata) {
      for (const field of ['title', 'duration', 'elapsedTime', 'playbackRate']) {
        if (metadata[field] !== undefined) normalized[field] = metadata[field];
      }
      normalized.artist = metadata.trackArtistName ?? metadata.albumArtistName;
      normalized.album = metadata.albumName;
      normalized.timestamp = metadata.elapsedTimeTimestamp;
    }
    const info = { ...normalized, ...player?.direct };
    return new NowPlayingInfo({ ...player?.state, displayName: client?.info.displayName ?? player?.state.displayName,
      playerPath: { client: client?.info, player: { identifier } },
      hasPlayback: Boolean(metadata || Object.keys(player?.direct ?? {}).length),
    }, info);
  }

  /** Apply a state/metadata/lifecycle message; true when the active snapshot may have changed. */
  update(type: number, payload: Payload): boolean {
    const path = payload.playerPath ?? {};
    const clientInfo = payload.client ?? path.client ?? {};
    const bundle = clientInfo.bundleIdentifier ?? '';
    let client = this.clients.get(bundle);
    if (!client) {
      client = { info: clientInfo, players: new Map() };
      this.clients.set(bundle, client);
    }
    client.info = { ...client.info, ...clientInfo };
    const identifier = path.player?.identifier ?? DEFAULT_PLAYER;
    if (type === MessageType.SetNowPlayingClient) {
      this.routingSelected = true;
      this.selected = true;
      // pyatv: an empty client is the '' bundle, a normal active client with no players.
      this.activeClient = bundle;
      return true;
    }
    if (type === MessageType.RemoveClient) {
      this.clients.delete(bundle);
      if (this.activeClient !== bundle) return false;
      this.activeClient = undefined;
      return true;
    }
    if (type === MessageType.SetNowPlayingPlayer) {
      client.active = path.player?.identifier || null;
      if (!this.selected) { this.activeClient = bundle; this.selected = true; }
      if (this.activeClient === bundle) this.routingSelected = true;
      return this.activeClient === bundle;
    }
    if (type === MessageType.RemovePlayer) {
      client.players.delete(identifier);
      if (client.active === identifier) client.active = null;
      return this.activeClient === bundle;
    }
    if (type === MessageType.SetDefaultSupportedCommands) {
      if (payload.supportedCommands) client.commands = SupportedCommand.fromList(payload.supportedCommands);
      return this.activeClient === bundle;
    }
    if (type === MessageType.UpdateClient) return this.activeClient === bundle;
    let player = client.players.get(identifier);
    if (!player) {
      player = { state: {}, direct: {}, items: [], location: 0 };
      client.players.set(identifier, player);
    }
    if (!this.selected) { this.activeClient = bundle; this.selected = true; client.active = identifier; }
    if (type === MessageType.SetState) {
      for (const field of ['playbackState', 'displayName']) {
        if (payload[field] !== undefined) player.state[field] = payload[field];
      }
      if (payload.playbackQueue) {
        // Keep only what snapshots and item updates read, so artwork buffers are not retained.
        player.items = (payload.playbackQueue.contentItems ?? []).map((item: Payload) => ({ identifier: item.identifier, metadata: item.metadata ? { ...item.metadata } : undefined }));
        player.location = payload.playbackQueue.location ?? 0;
        // Replaced queues must not inherit metadata from a previous track.
        player.direct = {};
      }
      if (payload.nowPlayingInfo) {
        const fields = { ...payload.nowPlayingInfo };
        if (fields.uniqueIdentifier !== undefined && player.direct.uniqueIdentifier !== undefined && String(fields.uniqueIdentifier) !== String(player.direct.uniqueIdentifier)) {
          player.direct = {};
          player.items = [];
        }
        player.direct = { ...player.direct, ...fields };
      }
      if (payload.supportedCommands) player.commands = SupportedCommand.fromList(payload.supportedCommands);
    } else if (type === MessageType.UpdateContentItem) {
      for (const item of payload.contentItems ?? []) {
        const existing = player.items.find(candidate => candidate.identifier === item.identifier);
        if (existing && item.metadata) {
          const changes = { ...item.metadata };
          existing.metadata = { ...existing.metadata, ...changes };
          if (existing === player.items[player.location]) {
            for (const field of ['title', 'duration', 'elapsedTime', 'playbackRate']) {
              if (Object.prototype.hasOwnProperty.call(changes, field)) delete player.direct[field];
            }
            if ('trackArtistName' in changes || 'albumArtistName' in changes) delete player.direct.artist;
            if ('albumName' in changes) delete player.direct.album;
            if ('elapsedTimeTimestamp' in changes) delete player.direct.timestamp;
          }
        }
      }
    }
    return this.activeClient === bundle && (client.active ?? DEFAULT_PLAYER) === identifier;
  }
}
