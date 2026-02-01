export enum Command {
  Unknown = 0,
  Play = 1,
  Pause = 2,
  TogglePlayPause = 3,
  Stop = 4,
  NextTrack = 5,
  PreviousTrack = 6,
  AdvanceShuffleMode = 7,
  AdvanceRepeatMode = 8,
  BeginFastForward = 9,
  EndFastForward = 10,
  BeginRewind = 11,
  EndRewind = 12,
  Rewind15Seconds = 13,
  FastForward15Seconds = 14,
  Rewind30Seconds = 15,
  FastForward30Seconds = 16,
  SkipForward = 18,
  SkipBackward = 19,
  ChangePlaybackRate = 20,
  RateTrack = 21,
  LikeTrack = 22,
  DislikeTrack = 23,
  BookmarkTrack = 24,
  NextChapter = 25,
  PreviousChapter = 26,
  NextAlbum = 27,
  PreviousAlbum = 28,
  NextPlaylist = 29,
  PreviousPlaylist = 30,
  BanTrack = 31,
  AddTrackToWishList = 32,
  RemoveTrackFromWishList = 33,
  NextInContext = 34,
  PreviousInContext = 35,
  ResetPlaybackTimeout = 41,
  SeekToPlaybackPosition = 45,
  ChangeRepeatMode = 46,
  ChangeShuffleMode = 47,
  SetPlaybackQueue = 48,
  AddNowPlayingItemToLibrary = 49,
  CreateRadioStation = 50,
  AddItemToLibrary = 51,
  InsertIntoPlaybackQueue = 52,
  EnableLanguageOption = 53,
  DisableLanguageOption = 54,
  ReorderPlaybackQueue = 55,
  RemoveFromPlaybackQueue = 56,
  PlayItemInPlaybackQueue = 57,
}

export class SupportedCommand {
  readonly command: Command;
  readonly enabled: boolean;
  readonly canScrub: boolean;

  constructor(payload: Record<string, unknown>) {
    this.command = (payload.command as Command) ?? Command.Unknown;
    this.enabled = (payload.enabled as boolean) ?? false;
    this.canScrub = Boolean(payload.canScrub);
  }

  toString(): string {
    const name = Command[this.command] ?? `Command(${this.command})`;
    const flags: string[] = [];
    if (this.enabled) flags.push('enabled');
    if (this.canScrub) flags.push('canScrub');
    return `${name} [${flags.join(', ')}]`;
  }

  static fromList(
    supportedCommands: Record<string, unknown>,
  ): SupportedCommand[] {
    const items = supportedCommands.supportedCommands as
      | Record<string, unknown>[]
      | undefined;
    if (!Array.isArray(items)) return [];
    return items.map((item) => new SupportedCommand(item));
  }
}
