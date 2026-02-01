import { describe, it, expect } from 'vitest';
import { MRPMessage, MessageType, HID_KEY_MAP } from '../messages.js';

describe('MRP Messages', () => {
  it('creates a DeviceInfoMessage', async () => {
    const msg = await MRPMessage.deviceInfo({
      uniqueIdentifier: 'test-device',
      name: 'Node ATV',
    });
    expect(msg).toBeInstanceOf(Buffer);
    expect(msg.length).toBeGreaterThan(0);
  });

  it('creates a SendCommandMessage', async () => {
    const msg = await MRPMessage.sendCommand(MessageType.SendCommand);
    expect(msg).toBeInstanceOf(Buffer);
  });

  it('decodes a ProtocolMessage', async () => {
    const msg = await MRPMessage.deviceInfo({
      uniqueIdentifier: 'test',
      name: 'test',
    });
    const decoded = await MRPMessage.decode(msg);
    expect(decoded).toBeDefined();
  });

  it('creates a SendButtonEventMessage', async () => {
    const msg = await MRPMessage.sendButtonEvent(1, 0x8C, true);
    expect(msg).toBeInstanceOf(Buffer);
    expect(msg.length).toBeGreaterThan(0);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.SendButtonEvent);
  });

  it('creates a SetConnectionStateMessage', async () => {
    const msg = await MRPMessage.setConnectionState(2);
    expect(msg).toBeInstanceOf(Buffer);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.SetConnectionState);
  });

  it('creates a ClientUpdatesConfigMessage', async () => {
    const msg = await MRPMessage.clientUpdatesConfig({
      nowPlayingUpdates: true,
      volumeUpdates: true,
    });
    expect(msg).toBeInstanceOf(Buffer);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.ClientUpdatesConfig);
  });

  it('creates a SendMediaCommand', async () => {
    const msg = await MRPMessage.sendMediaCommand(18); // SkipForward
    expect(msg).toBeInstanceOf(Buffer);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.SendCommand);
  });

  it('has HID key mappings for all remote buttons', () => {
    const expectedKeys = ['up', 'down', 'left', 'right', 'select', 'menu', 'home', 'top_menu', 'play_pause', 'volume_up', 'volume_down'];
    for (const key of expectedKeys) {
      expect(HID_KEY_MAP[key]).toBeDefined();
      expect(HID_KEY_MAP[key].usagePage).toBeGreaterThan(0);
      expect(HID_KEY_MAP[key].usage).toBeGreaterThan(0);
    }
  });

  it('creates a WakeDeviceMessage', async () => {
    const msg = await MRPMessage.wakeDevice();
    expect(msg).toBeInstanceOf(Buffer);
    expect(msg.length).toBeGreaterThan(0);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.WakeDevice);
  });

  it('creates a PlaybackQueueRequestMessage', async () => {
    const msg = await MRPMessage.playbackQueueRequest({
      location: 0,
      length: 5,
      includeMetadata: true,
      artworkWidth: 400,
      artworkHeight: 400,
    });
    expect(msg).toBeInstanceOf(Buffer);
    expect(msg.length).toBeGreaterThan(0);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.PlaybackQueueRequest);
  });

  it('creates a PlaybackQueueRequestMessage with defaults', async () => {
    const msg = await MRPMessage.playbackQueueRequest();
    expect(msg).toBeInstanceOf(Buffer);

    const decoded = await MRPMessage.decode(msg);
    expect(decoded.type).toBe(MessageType.PlaybackQueueRequest);
  });

  it('creates media commands for Play, Pause, NextTrack, PreviousTrack', async () => {
    for (const command of [1, 2, 5, 6]) {
      const msg = await MRPMessage.sendMediaCommand(command);
      expect(msg).toBeInstanceOf(Buffer);

      const decoded = await MRPMessage.decode(msg);
      expect(decoded.type).toBe(MessageType.SendCommand);
    }
  });
});
