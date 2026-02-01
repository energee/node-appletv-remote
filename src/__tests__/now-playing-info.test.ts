import { describe, it, expect } from 'vitest';
import { NowPlayingInfo, PlaybackState } from '../now-playing-info.js';

describe('NowPlayingInfo', () => {
  it('extracts fields from mock payloads', () => {
    const setStatePayload = {
      playbackState: PlaybackState.Playing,
      displayName: 'Music',
    };
    const nowPlayingPayload = {
      title: 'Test Song',
      artist: 'Test Artist',
      album: 'Test Album',
      duration: 200,
      elapsedTime: 90,
      playbackRate: 1,
      timestamp: 1234567890,
    };

    const info = new NowPlayingInfo(setStatePayload, nowPlayingPayload);

    expect(info.title).toBe('Test Song');
    expect(info.artist).toBe('Test Artist');
    expect(info.album).toBe('Test Album');
    expect(info.duration).toBe(200);
    expect(info.elapsedTime).toBe(90);
    expect(info.playbackRate).toBe(1);
    expect(info.playbackState).toBe(PlaybackState.Playing);
    expect(info.appDisplayName).toBe('Music');
    expect(info.timestamp).toBe(1234567890);
  });

  it('handles missing fields with defaults', () => {
    const info = new NowPlayingInfo({}, {});

    expect(info.title).toBe('');
    expect(info.artist).toBe('');
    expect(info.album).toBe('');
    expect(info.duration).toBe(0);
    expect(info.elapsedTime).toBe(0);
    expect(info.playbackRate).toBe(0);
    expect(info.playbackState).toBe(PlaybackState.Unknown);
    expect(info.appDisplayName).toBe('');
  });

  it('calculates percentCompleted correctly', () => {
    const info = new NowPlayingInfo({}, {
      duration: 200,
      elapsedTime: 90,
    });

    expect(info.percentCompleted()).toBe('45.00%');
  });

  it('returns 0.00% when duration is 0', () => {
    const info = new NowPlayingInfo({}, { duration: 0, elapsedTime: 50 });
    expect(info.percentCompleted()).toBe('0.00%');
  });

  it('produces a readable toString()', () => {
    const info = new NowPlayingInfo(
      { playbackState: PlaybackState.Playing, displayName: 'Music' },
      { title: 'Song', artist: 'Artist', album: 'Album', duration: 100, elapsedTime: 50 },
    );

    const str = info.toString();
    expect(str).toContain('Song');
    expect(str).toContain('by Artist');
    expect(str).toContain('on Album');
    expect(str).toContain('[Playing]');
    expect(str).toContain('50.00%');
    expect(str).toContain('(Music)');
  });

  it('toString works with minimal data', () => {
    const info = new NowPlayingInfo(
      { playbackState: PlaybackState.Paused },
      { title: 'Track' },
    );

    const str = info.toString();
    expect(str).toContain('Track');
    expect(str).toContain('[Paused]');
  });
});
