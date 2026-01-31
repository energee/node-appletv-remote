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

export class MRPMessage {
  static async deviceInfo(options: DeviceInfoOptions): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const DeviceInfoMessage = root.lookupType('DeviceInfoMessage');

    const deviceInfoPayload = DeviceInfoMessage.create({
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
    });

    const message = ProtocolMessage.create({
      type: MessageType.DeviceInfo,
      identifier: randomUUID().toUpperCase(),
      '.deviceInfoMessage': deviceInfoPayload,
    });

    const encoded = ProtocolMessage.encode(message).finish();
    return Buffer.from(encoded);
  }

  static async sendCommand(type: MessageType): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');

    const message = ProtocolMessage.create({
      type,
      identifier: randomUUID().toUpperCase(),
    });

    const encoded = ProtocolMessage.encode(message).finish();
    return Buffer.from(encoded);
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
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const SendHIDEventMessage = root.lookupType('SendHIDEventMessage');

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

    const hidPayload = SendHIDEventMessage.create({ hidEventData });

    const message = ProtocolMessage.create({
      type: MessageType.SendHIDEvent,
      identifier: randomUUID().toUpperCase(),
      '.sendHIDEventMessage': hidPayload,
    });

    return Buffer.from(ProtocolMessage.encode(message).finish());
  }

  static async sendButtonEvent(
    usagePage: number,
    usage: number,
    buttonDown: boolean,
  ): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const SendButtonEventMessage = root.lookupType('SendButtonEventMessage');

    const buttonPayload = SendButtonEventMessage.create({
      usagePage,
      usage,
      buttonDown,
    });

    const message = ProtocolMessage.create({
      type: MessageType.SendButtonEvent,
      identifier: randomUUID().toUpperCase(),
      '.sendButtonEventMessage': buttonPayload,
    });

    return Buffer.from(ProtocolMessage.encode(message).finish());
  }

  static async setConnectionState(state: number): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const SetConnectionStateMessage = root.lookupType('SetConnectionStateMessage');

    const payload = SetConnectionStateMessage.create({ state });

    const message = ProtocolMessage.create({
      type: MessageType.SetConnectionState,
      identifier: randomUUID().toUpperCase(),
      '.setConnectionStateMessage': payload,
    });

    return Buffer.from(ProtocolMessage.encode(message).finish());
  }

  static async clientUpdatesConfig(options: {
    artworkUpdates?: boolean;
    nowPlayingUpdates?: boolean;
    volumeUpdates?: boolean;
    keyboardUpdates?: boolean;
    outputDeviceUpdates?: boolean;
  }): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const ClientUpdatesConfigMessage = root.lookupType('ClientUpdatesConfigMessage');

    const payload = ClientUpdatesConfigMessage.create(options);

    const message = ProtocolMessage.create({
      type: MessageType.ClientUpdatesConfig,
      identifier: randomUUID().toUpperCase(),
      '.clientUpdatesConfigMessage': payload,
    });

    return Buffer.from(ProtocolMessage.encode(message).finish());
  }

  static async cryptoPairing(pairingData: Buffer): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const CryptoPairingMessage = root.lookupType('CryptoPairingMessage');

    const payload = CryptoPairingMessage.create({
      pairingData,
      status: 0,
      isRetrying: false,
      isUsingSystemPairing: false,
      state: 0,
    });

    // CryptoPairing messages must NOT include an identifier.
    // pyatv uses generate_identifier=False; the Apple TV never echoes
    // identifiers for crypto messages and may ignore requests that have one.
    const message = ProtocolMessage.create({
      type: MessageType.CryptoPairing,
      '.cryptoPairingMessage': payload,
    });

    return Buffer.from(ProtocolMessage.encode(message).finish());
  }

  static async sendMediaCommand(command: number): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const SendCommandMessage = root.lookupType('SendCommandMessage');

    const payload = SendCommandMessage.create({ command });

    const message = ProtocolMessage.create({
      type: MessageType.SendCommand,
      identifier: randomUUID().toUpperCase(),
      '.sendCommandMessage': payload,
    });

    return Buffer.from(ProtocolMessage.encode(message).finish());
  }
}
