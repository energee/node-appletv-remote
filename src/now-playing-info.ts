/**
 * Normalized now-playing snapshot built from MRP direct and queue metadata, emitted by AppleTV
 * as its `nowPlaying` event (and by DmapClient from DMAP play status).
 */

import type { RepeatState, ShuffleState } from './appletv.js';

/** A protobuf integer is public only when its decoded representation preserves its value. */
function identifier(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (value && typeof value === 'object' && 'toString' in value && typeof value.toString === 'function') {
    const text = value.toString();
    return /^-?\d+$/.test(text) ? text : undefined;
  }
  return undefined;
}


/** MRP queue media type values from ContentItemMetadata.MediaType. */
export enum MediaType {
  Audio = 1,
  Video = 2,
}

/** MRP queue media subtype values from ContentItemMetadata.MediaSubType. */
export enum MediaSubType {
  Music = 1,
  Podcast = 4,
  AudioBook = 5,
  ITunesU = 6,
}

/** Playback state as carried in SetStateMessage.playbackState. */
export enum PlaybackState {
  Unknown = 0,
  Playing = 1,
  Paused = 2,
  Stopped = 3,
  Interrupted = 4,
  Seeking = 5,
}
/** Track metadata and playback position for the currently playing item. */
export class NowPlayingInfo {
  /** False when the active player has no current metadata/item; separate from Stopped. */
  readonly hasPlayback: boolean;
  readonly playerIdentifier: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  /** Empty when unknown; supplied by DMAP or MRP queue metadata. */
  readonly genre: string;
  /** Undefined when unknown; supplied by DMAP or direct MRP now-playing metadata. */
  readonly shuffleState?: ShuffleState;
  /** Undefined when unknown; supplied by DMAP or direct MRP now-playing metadata. */
  readonly repeatState?: RepeatState;
  /** MRP queue media category, not the application's bundle identity. */
  readonly mediaType?: MediaType;
  /** MRP queue media subtype. */
  readonly mediaSubType?: MediaSubType;
  /** MRP queue series label, not an episode title; empty when unknown. */
  readonly seriesName: string;
  /** MRP queue season number; undefined when unknown. */
  readonly seasonNumber?: number;
  /** MRP queue episode number; undefined when unknown. */
  readonly episodeNumber?: number;
  /** MRP queue content identifier; empty when unknown. */
  readonly contentIdentifier: string;
  /** Direct MRP item identifier; undefined when unknown. */
  readonly uniqueIdentifier?: string;
  /** MRP queue store identifiers; undefined when absent or unsafe to represent. */
  readonly iTunesStoreIdentifier?: string;
  readonly iTunesStoreSubscriptionIdentifier?: string;
  readonly iTunesStoreArtistIdentifier?: string;
  readonly iTunesStoreAlbumIdentifier?: string;
  /** Track length in seconds; 0 when unknown. */
  readonly duration: number;
  /** Position in seconds as of `timestamp`, not live. */
  readonly elapsedTime: number;
  readonly playbackRate: number;
  /** True only when the source supplied a finite value; preserves explicit zero versus a missing timing field. */
  readonly hasDuration: boolean;
  readonly hasElapsedTime: boolean;
  readonly hasPlaybackRate: boolean;
  readonly playbackState: PlaybackState;
  readonly timestamp: number;
  readonly appDisplayName: string;
  readonly appBundleIdentifier: string;

  /**
   * Missing fields default to empty strings, 0, PlaybackState.Unknown, or undefined (shuffle/repeat).
   * @param setStatePayload State context; supplies playback state, presence, player and app identity.
   * @param nowPlayingPayload Normalized direct/queue fields; supplies track metadata and timing.
   */
  constructor(
    setStatePayload: Record<string, unknown>,
    nowPlayingPayload: Record<string, unknown>,
  ) {
    this.hasPlayback = (setStatePayload.hasPlayback as boolean) ?? (Object.keys(nowPlayingPayload).length > 0);
    const path = setStatePayload.playerPath as { player?: { identifier?: string } } | undefined;
    this.playerIdentifier = path?.player?.identifier ?? '';
    this.title = (nowPlayingPayload.title as string) ?? '';
    this.artist = (nowPlayingPayload.artist as string) ?? '';
    this.album = (nowPlayingPayload.album as string) ?? '';
    this.genre = (nowPlayingPayload.genre as string) ?? '';
    this.shuffleState = nowPlayingPayload.shuffleState === 1 || nowPlayingPayload.shuffleState === 2 || nowPlayingPayload.shuffleState === 3
      ? nowPlayingPayload.shuffleState as ShuffleState : undefined;
    this.repeatState = nowPlayingPayload.repeatState === 1 || nowPlayingPayload.repeatState === 2 || nowPlayingPayload.repeatState === 3
      ? nowPlayingPayload.repeatState as RepeatState : undefined;
    this.mediaType = nowPlayingPayload.mediaType === MediaType.Audio || nowPlayingPayload.mediaType === MediaType.Video
      ? nowPlayingPayload.mediaType : undefined;
    this.mediaSubType = nowPlayingPayload.mediaSubType === MediaSubType.Music || nowPlayingPayload.mediaSubType === MediaSubType.Podcast ||
      nowPlayingPayload.mediaSubType === MediaSubType.AudioBook || nowPlayingPayload.mediaSubType === MediaSubType.ITunesU
      ? nowPlayingPayload.mediaSubType : undefined;
    this.seriesName = (nowPlayingPayload.seriesName as string) ?? '';
    this.seasonNumber = typeof nowPlayingPayload.seasonNumber === 'number' && Number.isFinite(nowPlayingPayload.seasonNumber)
      ? nowPlayingPayload.seasonNumber : undefined;
    this.episodeNumber = typeof nowPlayingPayload.episodeNumber === 'number' && Number.isFinite(nowPlayingPayload.episodeNumber)
      ? nowPlayingPayload.episodeNumber : undefined;
    this.contentIdentifier = (nowPlayingPayload.contentIdentifier as string) ?? '';
    this.uniqueIdentifier = identifier(nowPlayingPayload.uniqueIdentifier);
    this.iTunesStoreIdentifier = identifier(nowPlayingPayload.iTunesStoreIdentifier);
    this.iTunesStoreSubscriptionIdentifier = identifier(nowPlayingPayload.iTunesStoreSubscriptionIdentifier);
    this.iTunesStoreArtistIdentifier = identifier(nowPlayingPayload.iTunesStoreArtistIdentifier);
    this.iTunesStoreAlbumIdentifier = identifier(nowPlayingPayload.iTunesStoreAlbumIdentifier);
    this.duration = (nowPlayingPayload.duration as number) ?? 0;
    this.elapsedTime = (nowPlayingPayload.elapsedTime as number) ?? 0;
    this.playbackRate = (nowPlayingPayload.playbackRate as number) ?? 0;
    this.hasDuration = Number.isFinite(nowPlayingPayload.duration);
    this.hasElapsedTime = Number.isFinite(nowPlayingPayload.elapsedTime);
    this.hasPlaybackRate = Number.isFinite(nowPlayingPayload.playbackRate);
    this.timestamp = (nowPlayingPayload.timestamp as number) ?? 0;
    // Some apps (Plex on tvOS 26.6) keep reporting Playing after a pause; only the rate drops to 0.
    const reported = (setStatePayload.playbackState as PlaybackState) ?? PlaybackState.Unknown;
    this.playbackState = reported === PlaybackState.Playing && this.hasPlaybackRate && this.playbackRate === 0
      ? PlaybackState.Paused : reported;
    this.appDisplayName = (setStatePayload.displayName as string) ?? '';
    const playerPath = setStatePayload.playerPath as { client?: { bundleIdentifier?: string } } | undefined;
    this.appBundleIdentifier = playerPath?.client?.bundleIdentifier ?? '';
  }

  /** Elapsed time as a percentage of duration with two decimals, e.g. `42.50%`; `0.00%` when duration is unknown. */
  percentCompleted(): string {
    if (this.duration <= 0) return '0.00%';
    const pct = (this.elapsedTime / this.duration) * 100;
    return `${pct.toFixed(2)}%`;
  }

  /** Human-readable summary: title, artist, album, state, progress and app, omitting empty parts. */
  toString(): string {
    const state = PlaybackState[this.playbackState] ?? 'Unknown';
    const parts: string[] = [];
    if (this.title) parts.push(this.title);
    if (this.artist) parts.push(`by ${this.artist}`);
    if (this.album) parts.push(`on ${this.album}`);
    parts.push(`[${state}]`);
    if (this.duration > 0) {
      parts.push(`${this.percentCompleted()}`);
    }
    if (this.appDisplayName) {
      parts.push(`(${this.appDisplayName})`);
    }
    return parts.join(' ');
  }
}
