import { describe, it, expect, vi } from 'vitest';
import { AppleTV, Key } from '../appletv.js';
import { Credentials } from '../credentials.js';
import { NowPlayingInfo } from '../now-playing-info.js';
import { SupportedCommand } from '../supported-command.js';
import { Message } from '../message.js';
import { MessageType } from '../mrp/messages.js';

describe('AppleTV', () => {
  it('creates from discovered device info', () => {
    const atv = new AppleTV({
      name: 'Living Room',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });
    expect(atv.name).toBe('Living Room');
    expect(atv.address).toBe('192.168.1.100');
  });

  it('has remote control methods', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });
    expect(typeof atv.up).toBe('function');
    expect(typeof atv.down).toBe('function');
    expect(typeof atv.left).toBe('function');
    expect(typeof atv.right).toBe('function');
    expect(typeof atv.select).toBe('function');
    expect(typeof atv.menu).toBe('function');
    expect(typeof atv.home).toBe('function');
    expect(typeof atv.playPause).toBe('function');
    expect(typeof atv.volumeUp).toBe('function');
    expect(typeof atv.volumeDown).toBe('function');
  });

  it('has new media control methods', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });
    expect(typeof atv.play).toBe('function');
    expect(typeof atv.pause).toBe('function');
    expect(typeof atv.stop).toBe('function');
    expect(typeof atv.next).toBe('function');
    expect(typeof atv.previous).toBe('function');
    expect(typeof atv.wake).toBe('function');
    expect(typeof atv.suspend).toBe('function');
    expect(typeof atv.requestPlaybackQueue).toBe('function');
    expect(typeof atv.requestArtwork).toBe('function');
    expect(typeof atv.sendKeyCommand).toBe('function');
  });

  it('throws when calling commands without connection', async () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });

    await expect(atv.play()).rejects.toThrow('Not connected');
    await expect(atv.pause()).rejects.toThrow('Not connected');
    await expect(atv.next()).rejects.toThrow('Not connected');
    await expect(atv.wake()).rejects.toThrow('Not connected');
    await expect(atv.suspend()).rejects.toThrow('Not connected');
    await expect(atv.requestPlaybackQueue()).rejects.toThrow('Not connected');
  });

  it('handleMRPMessage emits nowPlaying for SetState with nowPlayingInfo', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });

    const received: NowPlayingInfo[] = [];
    atv.on('nowPlaying', (info: NowPlayingInfo) => received.push(info));

    // Simulate an MRP message by calling handleMRPMessage via the internal handler
    // Since handleMRPMessage is private, we trigger it via the event path
    const msg = {
      type: MessageType.SetState,
      identifier: 'test-id',
      '.setStateMessage': {
        playbackState: 1,
        displayName: 'Music',
        nowPlayingInfo: {
          title: 'Song',
          artist: 'Artist',
          duration: 300,
          elapsedTime: 100,
        },
      },
    };

    // Access private method for testing
    (atv as any).handleMRPMessage(msg);

    expect(received).toHaveLength(1);
    expect(received[0].title).toBe('Song');
    expect(received[0].artist).toBe('Artist');
    expect(received[0].appDisplayName).toBe('Music');
  });

  it('handleMRPMessage emits supportedCommands for SetState with supportedCommands', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });

    const received: SupportedCommand[][] = [];
    atv.on('supportedCommands', (cmds: SupportedCommand[]) => received.push(cmds));

    (atv as any).handleMRPMessage({
      type: MessageType.SetState,
      identifier: 'test-id',
      '.setStateMessage': {
        supportedCommands: {
          supportedCommands: [
            { command: 1, enabled: true },
            { command: 2, enabled: true },
          ],
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
  });

  it('handleMRPMessage emits message for every MRP message', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });

    const received: Message[] = [];
    atv.on('message', (msg: Message) => received.push(msg));

    (atv as any).handleMRPMessage({
      type: MessageType.DeviceInfo,
      identifier: 'xyz',
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(MessageType.DeviceInfo);
  });

  it('handleMRPMessage emits playbackQueue', () => {
    const atv = new AppleTV({
      name: 'Test',
      address: '192.168.1.100',
      port: 7000,
      deviceId: 'AA:BB:CC',
      model: 'AppleTV6,2',
    });

    const received: Record<string, unknown>[] = [];
    atv.on('playbackQueue', (q: Record<string, unknown>) => received.push(q));

    (atv as any).handleMRPMessage({
      type: MessageType.SetState,
      identifier: 'test',
      '.setStateMessage': {
        playbackQueue: {
          contentItems: [{ identifier: 'item1' }],
        },
      },
    });

    expect(received).toHaveLength(1);
    expect((received[0].contentItems as any[])[0].identifier).toBe('item1');
  });
});

describe('Key enum', () => {
  it('has all expected key values', () => {
    expect(Key.Up).toBe('up');
    expect(Key.Play).toBe('play');
    expect(Key.Pause).toBe('pause');
    expect(Key.Next).toBe('next');
    expect(Key.Previous).toBe('previous');
    expect(Key.Wake).toBe('wake');
    expect(Key.Suspend).toBe('suspend');
  });
});

describe('Credentials', () => {
  it('serializes and deserializes', () => {
    const creds = new Credentials({
      clientId: 'abc',
      clientLTSK: Buffer.alloc(32, 0x01),
      clientLTPK: Buffer.alloc(32, 0x02),
      serverLTPK: Buffer.alloc(32, 0x03),
      serverId: 'server',
    });
    const serialized = creds.serialize();
    const restored = Credentials.deserialize(serialized);
    expect(restored.clientId).toBe('abc');
    expect(restored.serverLTPK).toEqual(Buffer.alloc(32, 0x03));
  });
});
