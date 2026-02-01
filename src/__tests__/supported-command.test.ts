import { describe, it, expect } from 'vitest';
import { SupportedCommand, Command } from '../supported-command.js';

describe('SupportedCommand', () => {
  it('extracts fields from mock payload', () => {
    const cmd = new SupportedCommand({
      command: Command.Play,
      enabled: true,
      canScrub: 1,
    });

    expect(cmd.command).toBe(Command.Play);
    expect(cmd.enabled).toBe(true);
    expect(cmd.canScrub).toBe(true);
  });

  it('handles missing fields with defaults', () => {
    const cmd = new SupportedCommand({});

    expect(cmd.command).toBe(Command.Unknown);
    expect(cmd.enabled).toBe(false);
    expect(cmd.canScrub).toBe(false);
  });

  it('produces a readable toString()', () => {
    const cmd = new SupportedCommand({
      command: Command.Pause,
      enabled: true,
      canScrub: 0,
    });

    const str = cmd.toString();
    expect(str).toContain('Pause');
    expect(str).toContain('enabled');
    expect(str).not.toContain('canScrub');
  });

  it('parses fromList correctly', () => {
    const list = SupportedCommand.fromList({
      supportedCommands: [
        { command: Command.Play, enabled: true },
        { command: Command.NextTrack, enabled: true },
        { command: Command.SkipForward, enabled: false },
      ],
    });

    expect(list).toHaveLength(3);
    expect(list[0].command).toBe(Command.Play);
    expect(list[1].command).toBe(Command.NextTrack);
    expect(list[2].enabled).toBe(false);
  });

  it('returns empty array from fromList when no commands', () => {
    expect(SupportedCommand.fromList({})).toEqual([]);
    expect(SupportedCommand.fromList({ supportedCommands: undefined })).toEqual([]);
  });
});
