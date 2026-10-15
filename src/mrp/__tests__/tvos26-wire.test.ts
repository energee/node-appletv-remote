/**
 * Wire fixtures for MRP messages tvOS 26.6 sends (#39, #40). Each hex string mirrors the
 * field layout captured from an AppleTV6,2 or AppleTV5,3, with UUIDs and IDs replaced.
 */
import { describe, expect, it } from 'vitest';
import { MRPMessage, MessageType } from '../messages.js';
import { Message } from '../../message.js';

const UUID = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const hex = (s: string) => Buffer.from(s, 'hex');
/** Type 104: envelope uniqueIdentifier (field 85) plus extension 86 with a player path and timestamp. */
const PLAYER_CLIENT_PROPERTIES = hex('0868aa052430303030303030302d303030302d303030302d303030302d303030303030303030303031b205640a590a0818cc86bde2042801121e08d8071210636f6d2e706c65786170702e706c657820f5033a04506c65781a2d0a194d6564696152656d6f74652d44656661756c74506c61796572120e44656661756c7420506c617965723000116abcd4ee863fc841');
/** Type 105: extension 87 with a timestamp and an undocumented UUID string in field 2. */
const ORIGIN_CLIENT_PROPERTIES = hex('0869aa052430303030303030302d303030302d303030302d303030302d303030303030303030303032ba052f093789b15c9e40c841122430303030303030302d303030302d303030302d303030302d303030303030303030303033');
/** Type 65: extension 69, one cluster-aware descriptor (trimmed) reporting volumeCapabilities 0. */
const UPDATE_OUTPUT_DEVICE = hex('0841aa046d1a6b0a0b46616d696c7920526f6f6d122430303030303030302d303030302d303030302d303030302d3030303030303030303030341a2430303030303030302d303030302d303030302d303030302d303030303030303030303035220a4170706c655456362c32a80200900304aa052430303030303030302d303030302d303030302d303030302d303030303030303030303036');
/** Type 63: reply to GetVolumeControlCapabilities, extension 67 wrapping {available, capabilities}. */
const capabilitiesResult = (available: 0 | 1, capabilities: number) =>
  hex(`083f122430303030303030302d303030302d303030302d303030302d3030303030303030303030379a04060a04080${available}100${capabilities}aa052430303030303030302d303030302d303030302d303030302d303030303030303030303038`);

describe('tvOS 26 MRP wire types', () => {
  it('keeps undeclared discriminators instead of dropping them', async () => {
    // type 120, then field 85 = "abc"
    const decoded = await MRPMessage.decode(hex('0878aa0503616263'));
    expect(decoded.type).toBe(120);
    expect(decoded.uniqueIdentifier).toBe('abc');
    expect(new Message(decoded).toString()).toContain('Unknown(120)');
  });

  it('decodes type 104 as PlayerClientProperties', async () => {
    const decoded = await MRPMessage.decode(PLAYER_CLIENT_PROPERTIES);
    expect(decoded.type).toBe(MessageType.PlayerClientProperties);
    expect(decoded.type).toBe(104);
    expect(decoded.uniqueIdentifier).toBe(UUID(1));
    expect(decoded['.playerClientPropertiesMessage']).toMatchObject({
      playerPath: { client: { bundleIdentifier: 'com.plexapp.plex' }, player: { identifier: 'MediaRemote-DefaultPlayer' } },
      lastPlayingTimestamp: 813632989.662,
    });
    expect(new Message(decoded).toString()).toContain('PlayerClientProperties');
  });

  it('decodes type 105 as OriginClientProperties', async () => {
    const decoded = await MRPMessage.decode(ORIGIN_CLIENT_PROPERTIES);
    expect(decoded.type).toBe(MessageType.OriginClientProperties);
    expect(decoded.type).toBe(105);
    expect(decoded['.originClientPropertiesMessage']).toMatchObject({ lastPlayingTimestamp: 813776057.387 });
  });

  it('decodes the type 65 UpdateOutputDevice payload', async () => {
    const decoded = await MRPMessage.decode(UPDATE_OUTPUT_DEVICE);
    expect(decoded.type).toBe(MessageType.UpdateOutputDevice);
    expect(decoded['.updateOutputDeviceMessage']).toEqual({
      clusterAwareOutputDevices: [{ name: 'Family Room', uniqueIdentifier: UUID(4), groupID: UUID(5), modelID: 'AppleTV6,2', volumeCapabilities: 0 }],
    });
  });

  it('keeps a type 65 with no payload as a bare UpdateOutputDevice', async () => {
    expect(await MRPMessage.decode(hex('0841'))).toEqual({ type: MessageType.UpdateOutputDevice });
  });

  it('decodes the GetVolumeControlCapabilities result', async () => {
    const decoded = await MRPMessage.decode(capabilitiesResult(1, 1));
    expect(decoded.type).toBe(MessageType.GetVolumeControlCapabilitiesResult);
    expect(decoded.type).toBe(63);
    expect(decoded['.getVolumeControlCapabilitiesResultMessage']).toEqual({
      capabilities: { volumeControlAvailable: true, volumeCapabilities: 1 },
    });
  });

  it('builds a bare GetVolumeControlCapabilities request with an identifier', async () => {
    const decoded = await MRPMessage.decode(await MRPMessage.sendCommand(MessageType.GetVolumeControlCapabilities));
    expect(decoded.type).toBe(62);
    expect(typeof decoded.identifier).toBe('string');
  });
});
