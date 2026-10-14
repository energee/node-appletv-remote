/**
 * MRP (Media Remote Protocol) message encoding and decoding.
 * Builds protobuf ProtocolMessage buffers for each command the library sends and
 * decodes incoming ones, using the schema precompiled into ./schema.ts.
 */

import protobuf from 'protobufjs';
import { randomUUID } from 'node:crypto';
import { MRP_SCHEMA } from './schema.js';

/** ProtocolMessage.type discriminators, not extension IDs; declare each value in ProtocolMessage.proto too. */
export enum MessageType {
  SendCommand = 1,
  SendCommandResult = 2,
  GetState = 3,
  SetState = 4,
  SetArtwork = 5,
  RegisterHIDDevice = 6,
  RegisterHIDDeviceResult = 7,
  SendHIDEvent = 8,
  SendVirtualTouchEvent = 10,
  Notification = 11,
  ContentItemsChangedNotification = 12,
  DeviceInfo = 15,
  ClientUpdatesConfig = 16,
  VolumeControlAvailability = 17,
  GameController = 18,
  RegisterGameController = 19,
  RegisterGameControllerResponse = 20,
  UnregisterGameController = 21,
  RegisterForGameControllerEvents = 22,
  Keyboard = 23,
  GetKeyboardSession = 24,
  TextInput = 25,
  GetVoiceInputDevices = 26,
  GetVoiceInputDevicesResponse = 27,
  RegisterVoiceInputDevice = 28,
  RegisterVoiceInputDeviceResponse = 29,
  SetRecordingState = 30,
  SendVoiceInput = 31,
  PlaybackQueueRequest = 32,
  Transaction = 33,
  CryptoPairing = 34,
  GameControllerProperties = 35,
  SetReadyState = 36,
  DeviceInfoUpdate = 37,
  SetConnectionState = 38,
  SendButtonEvent = 39,
  SetHiliteMode = 40,
  WakeDevice = 41,
  GenericMessage = 42,
  SetNowPlayingClient = 46,
  SetNowPlayingPlayer = 47,
  ModifyOutputContextRequest = 48,
  SetVolume = 51,
  VolumeDidChange = 52,
  RemoveClient = 53,
  RemovePlayer = 54,
  UpdateClient = 55,
  UpdateContentItem = 56,
  UpdateOutputDevice = 65,
  RemoveOutputDevices = 66,
  SetDefaultSupportedCommands = 72,
}

/** Player-state extension fields shared by normalization and sanitized routing diagnostics. */
export const PLAYER_STATE_FIELDS: Partial<Record<MessageType, string>> = {
  [MessageType.SetState]: '.setStateMessage', [MessageType.UpdateContentItem]: '.updateContentItemMessage',
  [MessageType.SetNowPlayingClient]: '.setNowPlayingClientMessage', [MessageType.SetNowPlayingPlayer]: '.setNowPlayingPlayerMessage',
  [MessageType.UpdateClient]: '.updateClientMessage', [MessageType.RemoveClient]: '.removeClientMessage',
  [MessageType.RemovePlayer]: '.removePlayerMessage', [MessageType.SetDefaultSupportedCommands]: '.setDefaultSupportedCommandsMessage',
};

// The MRP schema is compiled from src/proto into ./schema.ts by `npm run gen:proto`, so no
// .proto files are read at run time and bundlers (e.g. `bun build`) see a plain module.
// To support another message, add its file to PROTO_FILES in scripts/gen-proto.mjs.
/** Root built lazily from MRP_SCHEMA on first lookup. */
let root: protobuf.Root | null = null;
/** Cache of resolved message types by name. */
const types = new Map<string, protobuf.Type>();

/** Resolve a message type by name, caching it; every MRP send and receive goes through here. */
function lookupType(name: string): protobuf.Type {
  let type = types.get(name);
  if (!type) {
    root ??= protobuf.Root.fromJSON(MRP_SCHEMA as protobuf.INamespace);
    type = root.lookupType(name);
    types.set(name, type);
  }
  return type;
}

/** HID usage page/usage for each remote button sent via SendHIDEvent (page 1 = Generic Desktop, page 12 = Consumer). */
export const HID_KEY_MAP: Record<string, { usagePage: number; usage: number }> = {
  up:          { usagePage: 1, usage: 0x8C },
  down:        { usagePage: 1, usage: 0x8D },
  left:        { usagePage: 1, usage: 0x8B },
  right:       { usagePage: 1, usage: 0x8A },
  select:      { usagePage: 1, usage: 0x89 },
  menu:        { usagePage: 1, usage: 0x86 },
  home:        { usagePage: 12, usage: 0x40 },
  top_menu:    { usagePage: 12, usage: 0x60 },
  play_pause:  { usagePage: 12, usage: 0xB0 },
  volume_up:   { usagePage: 12, usage: 0xE9 },
  volume_down: { usagePage: 12, usage: 0xEA },
};

/** Fields for the DeviceInfo handshake message; omitted fields default to values identifying us as the iOS TV Remote app. */
export interface DeviceInfoOptions {
  uniqueIdentifier: string;
  name: string;
  localizedModelName?: string;
  systemBuildVersion?: string;
  applicationBundleIdentifier?: string;
  protocolVersion?: number;
  lastSupportedMessageType?: number;
  supportsSystemPairing?: boolean;
  allowsPairing?: boolean;
  systemMediaApplication?: string;
  supportsACL?: boolean;
  supportsSharedQueue?: boolean;
  sharedQueueVersion?: number;
  supportsExtendedMotion?: boolean;
}

/**
 * Encode a ProtocolMessage with the given type and optional extension payload.
 * Most MRP messages follow this pattern: create a typed ProtocolMessage with
 * a random uppercase UUID identifier and an optional nested extension message.
 * `extension.key` is the protobufjs extension field name (leading dot, e.g. '.sendCommandMessage').
 */
async function encodeMessage(
  type: MessageType,
  extension?: { key: string; typeName: string; fields: Record<string, unknown> },
  options?: { omitIdentifier?: boolean },
): Promise<Buffer> {
  const ProtocolMessage = lookupType('ProtocolMessage');

  const fields: Record<string, unknown> = { type };
  if (!options?.omitIdentifier) {
    fields.identifier = randomUUID().toUpperCase();
  }

  if (extension) {
    const ExtType = lookupType(extension.typeName);
    fields[extension.key] = ExtType.create(extension.fields);
  }

  const message = ProtocolMessage.create(fields);
  return Buffer.from(ProtocolMessage.encode(message).finish());
}

/** Static builders that return encoded ProtocolMessage buffers ready to frame and send, plus `decode` for incoming ones. */
export class MRPMessage {
  /** Shared audio routing uses discriminator 48, extension 52; paired fields support cluster-aware receivers. */
  static async modifyOutputDevices(mode: 'add' | 'remove' | 'set', devices: string[]): Promise<Buffer> {
    const field = { add: 'addingDevices', remove: 'removingDevices', set: 'settingDevices' }[mode];
    return encodeMessage(MessageType.ModifyOutputContextRequest, {
      key: '.modifyOutputContextRequestMessage', typeName: 'ModifyOutputContextRequestMessage',
      fields: { type: 1, [field]: devices,
        [`clusterAware${field[0].toUpperCase()}${field.slice(1)}`]: devices },
    });
  }

  /** DeviceInfo: the first message after connecting, describing this client to the Apple TV. */
  static async deviceInfo(options: DeviceInfoOptions): Promise<Buffer> {
    return encodeMessage(MessageType.DeviceInfo, {
      key: '.deviceInfoMessage',
      typeName: 'DeviceInfoMessage',
      fields: {
        uniqueIdentifier: options.uniqueIdentifier,
        name: options.name,
        localizedModelName: options.localizedModelName ?? 'iPhone',
        systemBuildVersion: options.systemBuildVersion ?? '17B111',
        applicationBundleIdentifier:
          options.applicationBundleIdentifier ?? 'com.apple.TVRemote',
        applicationBundleVersion: '344.28',
        protocolVersion: options.protocolVersion ?? 1,
        lastSupportedMessageType: options.lastSupportedMessageType ?? 108,
        supportsSystemPairing: options.supportsSystemPairing ?? true,
        allowsPairing: options.allowsPairing ?? true,
        systemMediaApplication: options.systemMediaApplication ?? 'com.apple.TVMusic',
        supportsACL: options.supportsACL ?? true,
        supportsSharedQueue: options.supportsSharedQueue ?? true,
        sharedQueueVersion: options.sharedQueueVersion ?? 2,
        supportsExtendedMotion: options.supportsExtendedMotion ?? true,
      },
    });
  }

  /** A bare ProtocolMessage of the given type with no extension payload. */
  static async sendCommand(type: MessageType): Promise<Buffer> {
    return encodeMessage(type);
  }

  /** Decode a ProtocolMessage; extensions appear as '.fooMessage' keys on the result. */
  static async decode(
    buffer: Buffer,
  ): Promise<protobuf.Message & Record<string, unknown>> {
    const ProtocolMessage = lookupType('ProtocolMessage');
    const decoded = ProtocolMessage.decode(buffer);
    return decoded as protobuf.Message & Record<string, unknown>;
  }

  /**
   * SendHIDEvent: a single key down or up as a raw IOHIDEvent blob. A button press
   * is a down event followed by an up event.
   */
  static async sendHIDEvent(
    usagePage: number,
    usage: number,
    down: boolean,
  ): Promise<Buffer> {
    // Build raw HID event data matching IOHIDEvent format.
    // Format: [8B timestamp][fixed header][usagePage 2B BE][usage 2B BE][down 2B BE][fixed footer]
    // The timestamp is a fixed constant, not the current time.
    const timestamp = Buffer.from('438922cf08020000', 'hex');
    const header = Buffer.from(
      '0000000000000000010000000000000002000000200000000300000001000000000000',
      'hex',
    );
    const data = Buffer.alloc(6);
    data.writeUInt16BE(usagePage, 0);
    data.writeUInt16BE(usage, 2);
    data.writeUInt16BE(down ? 1 : 0, 4);
    const footer = Buffer.from('0000000000000001000000', 'hex');

    const hidEventData = Buffer.concat([timestamp, header, data, footer]);

    return encodeMessage(MessageType.SendHIDEvent, {
      key: '.sendHIDEventMessage',
      typeName: 'SendHIDEventMessage',
      fields: { hidEventData },
    });
  }

  /** SendButtonEvent: type 39 with extension field 43, carrying HID usage page, usage and down/up. */
  static async sendButtonEvent(
    usagePage: number,
    usage: number,
    buttonDown: boolean,
  ): Promise<Buffer> {
    return encodeMessage(MessageType.SendButtonEvent, {
      key: '.sendButtonEventMessage',
      typeName: 'SendButtonEventMessage',
      fields: { usagePage, usage, buttonDown },
    });
  }

  /** SetConnectionState with a ConnectionState value (0 None, 1 Connecting, 2 Connected, 3 Disconnected). */
  static async setConnectionState(state: number): Promise<Buffer> {
    return encodeMessage(MessageType.SetConnectionState, {
      key: '.setConnectionStateMessage',
      typeName: 'SetConnectionStateMessage',
      fields: { state },
    });
  }

  /** ClientUpdatesConfig: subscribe to the categories of state updates the Apple TV should push. */
  static async clientUpdatesConfig(options: {
    artworkUpdates?: boolean;
    nowPlayingUpdates?: boolean;
    volumeUpdates?: boolean;
    keyboardUpdates?: boolean;
    outputDeviceUpdates?: boolean;
  }): Promise<Buffer> {
    return encodeMessage(MessageType.ClientUpdatesConfig, {
      key: '.clientUpdatesConfigMessage',
      typeName: 'ClientUpdatesConfigMessage',
      fields: options,
    });
  }

  /** CryptoPairing: wraps HAP TLV; isPairing selects state 2 for pair-setup M1 only. */
  static async cryptoPairing(pairingData: Buffer, isPairing = false): Promise<Buffer> {
    // CryptoPairing messages must NOT include an identifier.
    // pyatv uses generate_identifier=False; the Apple TV never echoes
    // identifiers for crypto messages and may ignore requests that have one.
    return encodeMessage(
      MessageType.CryptoPairing,
      {
        key: '.cryptoPairingMessage',
        typeName: 'CryptoPairingMessage',
        fields: {
          pairingData,
          status: 0,
          isRetrying: false,
          isUsingSystemPairing: false,
          state: isPairing ? 2 : 0,
        },
      },
      { omitIdentifier: true },
    );
  }

  /** SendCommand with optional CommandOptions (e.g. playbackPosition, shuffleMode, skipInterval). */
  static async sendMediaCommand(
    command: number,
    options?: Record<string, unknown>,
  ): Promise<Buffer> {
    const fields: Record<string, unknown> = { command };
    if (options) fields.options = lookupType('CommandOptions').create(options);
    return encodeMessage(MessageType.SendCommand, {
      key: '.sendCommandMessage',
      typeName: 'SendCommandMessage',
      fields,
    });
  }

  /** Set absolute volume (0..1) on an output device (pyatv: messages.set_volume). */
  static async setVolume(outputDeviceUID: string, volume: number): Promise<Buffer> {
    return encodeMessage(MessageType.SetVolume, {
      key: '.setVolumeMessage',
      typeName: 'SetVolumeMessage',
      fields: { outputDeviceUID, volume },
    });
  }

  /** WakeDevice: wake the Apple TV from sleep. */
  static async wakeDevice(): Promise<Buffer> {
    return encodeMessage(MessageType.WakeDevice, {
      key: '.wakeDeviceMessage',
      typeName: 'WakeDeviceMessage',
      fields: {},
    });
  }

  /** TextInput: edit the focused text field; `actionType` is the TextInputMessage action enum (1 = Insert, 2 = Set, 3 = Delete, 4 = ClearText). */
  static async textInput(
    text: string,
    actionType: number,
  ): Promise<Buffer> {
    return encodeMessage(MessageType.TextInput, {
      key: '.textInputMessage',
      typeName: 'TextInputMessage',
      fields: {
        timestamp: Date.now() / 1000,
        text,
        actionType,
      },
    });
  }

  /** PlaybackQueueRequest: ask for queue items (defaults: the current item with metadata, no artwork); the reply is a SetState. */
  static async playbackQueueRequest(options: {
    location?: number;
    length?: number;
    includeMetadata?: boolean;
    artworkWidth?: number;
    artworkHeight?: number;
    includeLyrics?: boolean;
    includeInfo?: boolean;
    includeLanguageOptions?: boolean;
  } = {}): Promise<Buffer> {
    return encodeMessage(MessageType.PlaybackQueueRequest, {
      key: '.playbackQueueRequestMessage',
      typeName: 'PlaybackQueueRequestMessage',
      fields: {
        location: options.location ?? 0,
        length: options.length ?? 1,
        includeMetadata: options.includeMetadata ?? true,
        artworkWidth: options.artworkWidth ?? 0,
        artworkHeight: options.artworkHeight ?? 0,
        includeLyrics: options.includeLyrics ?? false,
        includeInfo: options.includeInfo ?? false,
        includeLanguageOptions: options.includeLanguageOptions ?? false,
      },
    });
  }
}
