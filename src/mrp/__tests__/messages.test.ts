/** MRP builder and decoder regressions, including independent wire fixtures. */
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

  it('decodes a Generic flush from independent wire bytes as type 42', async () => {
    const decoded = await MRPMessage.decode(Buffer.from('082a', 'hex'));
    expect(decoded.type).toBe(42);
    expect(Object.hasOwn(decoded, 'type')).toBe(true);
  });

  it('encodes a Generic flush with wire discriminator 42', async () => {
    const msg = await MRPMessage.sendCommand(MessageType.GenericMessage);
    expect(msg.subarray(0, 2).toString('hex')).toBe('082a');
    expect((await MRPMessage.decode(msg)).type).toBe(42);
  });

  it('encodes SendButton with type 39 and payload extension 43', async () => {
    const msg = await MRPMessage.sendButtonEvent(1, 0x8C, true);
    expect(msg.subarray(0, 2).toString('hex')).toBe('0827');
    expect(msg.subarray(msg.indexOf(Buffer.from('da02', 'hex'))).toString('hex'))
      .toBe('da02070801108c011801');
  });

  it('decodes the independent type 39 SendButton fixture', async () => {
    const decoded = await MRPMessage.decode(Buffer.from('0827da02070801108c011801', 'hex'));
    expect(decoded.type).toBe(39);
    expect(decoded['.sendButtonEventMessage']).toMatchObject({
      usagePage: 1, usage: 0x8C, buttonDown: true,
    });
  });

  it('decodes a ProtocolMessage', async () => {
    const msg = await MRPMessage.deviceInfo({
      uniqueIdentifier: 'test',
      name: 'test',
    });
    const decoded = await MRPMessage.decode(msg);
    expect(decoded).toBeDefined();
  });

  it('decodes only fields present on the wire (no proto defaults or empty repeated fields)', async () => {
    // type=4 with an empty SetStateMessage extension (field 9).
    const setState = await MRPMessage.decode(Buffer.from('08044a00', 'hex'));
    expect(setState['.setStateMessage']).toEqual({});
    const info = (await MRPMessage.decode(await MRPMessage.deviceInfo({ uniqueIdentifier: 'u', name: 'n' })))['.deviceInfoMessage'] as Record<string, unknown>;
    expect(Object.hasOwn(info, 'groupedDevices')).toBe(false);
    expect(info.uniqueIdentifier).toBe('u');
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
