import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = join(__dirname, '..', 'proto');

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
  SetHiliteMode = 40,
  WakeDevice = 41,
  GenericMessage = 42,
  SendButtonEvent = 43,
  SetNowPlayingClient = 46,
  UpdateClient = 55,
  UpdateContentItem = 56,
}

let rootPromise: Promise<protobuf.Root> | null = null;

// Core proto files to load. Many of the proto files in the proto directory have
// conflicting extension IDs or duplicate type names, so we load only the files
// needed for our use cases. Additional files can be added as needed, but must
// be checked for conflicts first.
const PROTO_FILES = [
  'ProtocolMessage.proto',
  'DeviceInfoMessage.proto',
  'SendCommandMessage.proto',
  'CryptoPairingMessage.proto',
  'ClientUpdatesConfigMessage.proto',
  'SetStateMessage.proto',
  'GetStateMessage.proto',
  'NotificationMessage.proto',
  'KeyboardMessage.proto',
  'TextInputMessage.proto',
  'GetKeyboardSessionMessage.proto',
  'VolumeControlAvailabilityMessage.proto',
  'WakeDeviceMessage.proto',
  'SetConnectionStateMessage.proto',
  'SetHiliteModeMessage.proto',
  'SetNowPlayingClientMessage.proto',
  'PlaybackQueueRequestMessage.proto',
  'TransactionMessage.proto',
  'UpdateClientMessage.proto',
  'UpdateContentItemMessage.proto',
  'SendButtonEventMessage.proto',
  'SendHIDEventMessage.proto',
];

async function loadRoot(): Promise<protobuf.Root> {
  if (!rootPromise) {
    rootPromise = (async () => {
      const root = new protobuf.Root();
      root.resolvePath = (_origin: string, target: string) => {
        // If target is already absolute, return as-is
        if (target.startsWith('/')) return target;
        return join(PROTO_DIR, target);
      };

      await root.load(
        PROTO_FILES,
        { keepCase: true },
      );

      root.resolveAll();
      return root;
    })();
  }
  return rootPromise;
}

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
 * an identifier and an optional nested extension message.
 */
async function encodeMessage(
  type: MessageType,
  extension?: { key: string; typeName: string; fields: Record<string, unknown> },
  options?: { omitIdentifier?: boolean },
): Promise<Buffer> {
  const root = await loadRoot();
  const ProtocolMessage = root.lookupType('ProtocolMessage');

  const fields: Record<string, unknown> = { type };
  if (!options?.omitIdentifier) {
    fields.identifier = randomUUID().toUpperCase();
  }

  if (extension) {
    const ExtType = root.lookupType(extension.typeName);
    fields[extension.key] = ExtType.create(extension.fields);
  }

  const message = ProtocolMessage.create(fields);
  return Buffer.from(ProtocolMessage.encode(message).finish());
}

export class MRPMessage {
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

  static async sendCommand(type: MessageType): Promise<Buffer> {
    return encodeMessage(type);
  }

  static async decode(
    buffer: Buffer,
  ): Promise<protobuf.Message & Record<string, unknown>> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const decoded = ProtocolMessage.decode(buffer);
    return decoded as protobuf.Message & Record<string, unknown>;
  }

  static async sendHIDEvent(
    usagePage: number,
    usage: number,
    down: boolean,
  ): Promise<Buffer> {
    // Build raw HID event data matching IOHIDEvent format.
    // Format: [8B timestamp][fixed header][usagePage 2B BE][usage 2B BE][down 2B BE][fixed footer]
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

  static async setConnectionState(state: number): Promise<Buffer> {
    return encodeMessage(MessageType.SetConnectionState, {
      key: '.setConnectionStateMessage',
      typeName: 'SetConnectionStateMessage',
      fields: { state },
    });
  }

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

  static async cryptoPairing(pairingData: Buffer): Promise<Buffer> {
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
          state: 0,
        },
      },
      { omitIdentifier: true },
    );
  }

  static async sendMediaCommand(command: number): Promise<Buffer> {
    return encodeMessage(MessageType.SendCommand, {
      key: '.sendCommandMessage',
      typeName: 'SendCommandMessage',
      fields: { command },
    });
  }

  static async wakeDevice(): Promise<Buffer> {
    return encodeMessage(MessageType.WakeDevice, {
      key: '.wakeDeviceMessage',
      typeName: 'WakeDeviceMessage',
      fields: {},
    });
  }

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
