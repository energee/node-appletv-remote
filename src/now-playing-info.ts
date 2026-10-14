/**
 * Normalized now-playing snapshot built from MRP direct and queue metadata, emitted by AppleTV
 * as its `nowPlaying` event.
 */

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
  /** Track length in seconds; 0 when unknown. */
  readonly duration: number;
  /** Position in seconds as of `timestamp`, not live. */
  readonly elapsedTime: number;
  readonly playbackRate: number;
  readonly playbackState: PlaybackState;
  readonly timestamp: number;
  readonly appDisplayName: string;
  readonly appBundleIdentifier: string;

  /**
   * Missing fields default to empty strings, 0, or PlaybackState.Unknown.
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
    this.duration = (nowPlayingPayload.duration as number) ?? 0;
    this.elapsedTime = (nowPlayingPayload.elapsedTime as number) ?? 0;
    this.playbackRate = (nowPlayingPayload.playbackRate as number) ?? 0;
    this.timestamp = (nowPlayingPayload.timestamp as number) ?? 0;
    this.playbackState =
      (setStatePayload.playbackState as PlaybackState) ?? PlaybackState.Unknown;
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
