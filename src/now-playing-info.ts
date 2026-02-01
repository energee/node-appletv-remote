export enum PlaybackState {
  Unknown = 0,
  Playing = 1,
  Paused = 2,
  Stopped = 3,
  Interrupted = 4,
  Seeking = 5,
}


export class NowPlayingInfo {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly duration: number;
  readonly elapsedTime: number;
  readonly playbackRate: number;
  readonly playbackState: PlaybackState;
  readonly timestamp: number;
  readonly appDisplayName: string;
  readonly appBundleIdentifier: string;

  constructor(
    setStatePayload: Record<string, unknown>,
    nowPlayingPayload: Record<string, unknown>,
  ) {
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
    this.appBundleIdentifier = '';
  }

  percentCompleted(): string {
    if (this.duration <= 0) return '0.00%';
    const pct = (this.elapsedTime / this.duration) * 100;
    return `${pct.toFixed(2)}%`;
  }

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
