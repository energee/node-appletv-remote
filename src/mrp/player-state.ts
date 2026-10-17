/** Player-scoped MRP snapshots with field-presence semantics. */
import { NowPlayingInfo } from '../now-playing-info.js';
import { SupportedCommand } from '../supported-command.js';
import { MessageType } from './messages.js';

type Payload = Record<string, any>;
interface Player {
  /** Only the SetState fields snapshot() reads (playbackState, displayName); never queue/artwork payloads. */
  state: Payload;
  direct: Payload;
  /** A direct now-playing payload had fields, even when all of them are intentionally unnormalized. */
  hasDirectMetadata?: boolean;
  items: Payload[];
  location: number;
  /** A SetState carried state (see carriesState); identity/commands alone do not set it. */
  hasState?: boolean;
  commands?: SupportedCommand[];
}
interface Client {
  info: Payload;
  players: Map<string, Player>;
  active?: string | null;
  commands?: SupportedCommand[];
}
/** Player identifier MRP implies when a playerPath omits one. */
export const DEFAULT_PLAYER = 'MediaRemote-DefaultPlayer';
/** Bundle key for a client without a bundle identifier; the empty now-playing client (idle TV) is modeled this way. */
const EMPTY_CLIENT = '';

/** SetState evidence of player state: playback state (even unknown), a queue (even empty), or direct now-playing fields. */
export function carriesState(setState: Payload): boolean {
  return typeof setState.playbackState === 'number' || setState.playbackQueue !== undefined ||
    Object.keys(setState.nowPlayingInfo ?? {}).length > 0;
}

/** Retain only fields that feed the normalized snapshot; opaque metadata must not pin a frame. */
function retain(fields: Payload, names: readonly string[]): Payload {
  const retained: Payload = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(fields, name)) retained[name] = fields[name];
  }
  return retained;
}

const DIRECT_FIELDS = ['title', 'artist', 'album', 'duration', 'elapsedTime', 'playbackRate', 'repeatMode', 'shuffleMode', 'timestamp', 'uniqueIdentifier'] as const;
const METADATA_FIELDS = ['title', 'duration', 'elapsedTime', 'playbackRate', 'trackArtistName', 'albumArtistName', 'albumName', 'elapsedTimeTimestamp', 'genre', 'contentIdentifier', 'iTunesStoreIdentifier', 'iTunesStoreSubscriptionIdentifier', 'iTunesStoreArtistIdentifier', 'iTunesStoreAlbumIdentifier', 'seriesName', 'mediaType', 'mediaSubType', 'seasonNumber', 'episodeNumber'] as const;

/** A protobuf integer has a stable track identity only if its decoded form is lossless. */
function stableIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (value && typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
    const text = value.toString();
    return /^-?\d+$/.test(text) ? text : undefined;
  }
  return undefined;
}

/** Keeps inactive-player updates separate until the device selects that client/player. */
export class PlayerState {
  private clients = new Map<string, Client>();
  private activeClient?: string;
  private selected = false;
  private routed = false;

  /** Current active-player commands; undefined means no advertisement has arrived. */
  get commands(): SupportedCommand[] | undefined {
    const client = this.activeClient === undefined ? undefined : this.clients.get(this.activeClient);
    const player = client?.active === null ? undefined : client?.players.get(client.active ?? DEFAULT_PLAYER);
    if (!player?.commands) return client?.commands;
    return [...player.commands, ...(client?.commands ?? []).filter(cmd => !player.commands!.some(p => p.command === cmd.command))];
  }

  /** A SetNowPlayingClient/SetNowPlayingPlayer routing selection chose the current client (not the legacy first-state fallback). */
  get routingSelected(): boolean {
    return this.routed;
  }

  /**
   * Cache bypass requires a device routing selection, not the legacy first-state fallback.
   * A selected empty client (idle TV) with no selected player is itself a definitive nothing-playing snapshot.
   */
  get hasSelectedSnapshot(): boolean {
    return this.routed && (this.hasSnapshot ||
      (this.activeClient === EMPTY_CLIENT && this.clients.get(EMPTY_CLIENT)?.active === undefined));
  }

  /** Received state for the model's current player (also the legacy first-state fallback). Identity/commands alone are not state. */
  get hasSnapshot(): boolean {
    const client = this.activeClient === undefined ? undefined : this.clients.get(this.activeClient);
    const player = client?.active === null ? undefined : client?.players.get(client.active ?? DEFAULT_PLAYER);
    return player?.hasState === true;
  }

  /** Fresh normalized snapshot without position extrapolation. */
  snapshot(): NowPlayingInfo {
    const client = this.activeClient === undefined ? undefined : this.clients.get(this.activeClient);
    const identifier = client?.active ?? DEFAULT_PLAYER;
    const player = client?.active === null ? undefined : client?.players.get(identifier);
    const metadata = player?.items[player.location]?.metadata;
    const normalized: Payload = {};
    if (metadata) {
      for (const field of ['title', 'duration', 'elapsedTime', 'playbackRate', 'genre', 'contentIdentifier',
        'iTunesStoreIdentifier', 'iTunesStoreSubscriptionIdentifier', 'iTunesStoreArtistIdentifier',
        'iTunesStoreAlbumIdentifier', 'seriesName', 'mediaType', 'mediaSubType', 'seasonNumber', 'episodeNumber']) {
        if (Object.prototype.hasOwnProperty.call(metadata, field)) normalized[field] = metadata[field];
      }
      if (Object.prototype.hasOwnProperty.call(metadata, 'trackArtistName')) normalized.artist = metadata.trackArtistName;
      else if (Object.prototype.hasOwnProperty.call(metadata, 'albumArtistName')) normalized.artist = metadata.albumArtistName;
      if (Object.prototype.hasOwnProperty.call(metadata, 'albumName')) normalized.album = metadata.albumName;
      if (Object.prototype.hasOwnProperty.call(metadata, 'elapsedTimeTimestamp')) normalized.timestamp = metadata.elapsedTimeTimestamp;
    }
    if (player?.direct) {
      for (const [field, value] of Object.entries(player.direct)) {
        if (field === 'repeatMode') normalized.repeatState = value;
        else if (field === 'shuffleMode') normalized.shuffleState = value;
        else normalized[field] = value;
      }
    }
    const info = normalized;
    return new NowPlayingInfo({ ...player?.state, displayName: client?.info.displayName ?? player?.state.displayName,
      playerPath: { client: client?.info, player: { identifier } },
      hasPlayback: Boolean(metadata || player?.hasDirectMetadata),
    }, info);
  }

  /** Apply a state/metadata/lifecycle message; true when the active snapshot may have changed. */
  update(type: number, payload: Payload): boolean {
    const path = payload.playerPath ?? {};
    const clientInfo = payload.client ?? path.client ?? {};
    const bundle = clientInfo.bundleIdentifier ?? EMPTY_CLIENT;
    let client = this.clients.get(bundle);
    if (!client) {
      client = { info: clientInfo, players: new Map() };
      this.clients.set(bundle, client);
    }
    client.info = { ...client.info, ...clientInfo };
    const identifier = path.player?.identifier ?? DEFAULT_PLAYER;
    if (type === MessageType.SetNowPlayingClient) {
      this.routed = true;
      this.selected = true;
      // An empty client is the EMPTY_CLIENT bundle, a normal active client with no players.
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
      if (this.activeClient === bundle) this.routed = true;
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
      if (carriesState(payload)) player.hasState = true;
      for (const field of ['playbackState', 'displayName']) {
        if (payload[field] !== undefined) player.state[field] = payload[field];
      }
      if (payload.playbackQueue !== undefined) {
        // Keep only snapshot fields; opaque queue blobs and artwork must not be retained.
        player.items = (payload.playbackQueue.contentItems ?? []).map((item: Payload) => ({
          identifier: item.identifier,
          metadata: item.metadata ? retain(item.metadata, METADATA_FIELDS) : undefined,
        }));
        player.location = payload.playbackQueue.location ?? 0;
        // Replaced queues must not inherit metadata from a previous track.
        player.direct = {};
        player.hasDirectMetadata = false;
      }
      if (payload.nowPlayingInfo !== undefined) {
        const directPayload = payload.nowPlayingInfo;
        const fields = retain(directPayload, DIRECT_FIELDS);
        const nextIdentifier = stableIdentifier(fields.uniqueIdentifier);
        const previousIdentifier = stableIdentifier(player.direct.uniqueIdentifier);
        if (nextIdentifier !== undefined && previousIdentifier !== undefined && nextIdentifier !== previousIdentifier) {
          player.direct = {};
          player.items = [];
        }
        player.direct = { ...player.direct, ...fields };
        if (Object.keys(directPayload).length > 0) player.hasDirectMetadata = true;
      }
      if (payload.supportedCommands) player.commands = SupportedCommand.fromList(payload.supportedCommands);
    } else if (type === MessageType.UpdateContentItem) {
      for (const item of payload.contentItems ?? []) {
        const existing = player.items.find(candidate => candidate.identifier === item.identifier);
        if (existing && item.metadata) {
          const changes = retain(item.metadata, METADATA_FIELDS);
          existing.metadata = { ...existing.metadata, ...changes };
          if (existing === player.items[player.location]) {
            for (const field of ['title', 'duration', 'elapsedTime', 'playbackRate']) {
              if (Object.prototype.hasOwnProperty.call(changes, field)) delete player.direct[field];
            }
            if (Object.prototype.hasOwnProperty.call(changes, 'trackArtistName') || Object.prototype.hasOwnProperty.call(changes, 'albumArtistName')) delete player.direct.artist;
            if (Object.prototype.hasOwnProperty.call(changes, 'albumName')) delete player.direct.album;
            if (Object.prototype.hasOwnProperty.call(changes, 'elapsedTimeTimestamp')) delete player.direct.timestamp;
          }
        }
      }
    }
    return this.activeClient === bundle && (client.active ?? DEFAULT_PLAYER) === identifier;
  }
}
