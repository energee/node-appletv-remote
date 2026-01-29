import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
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
  SendPackedVirtualTouchEvent = 43,
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

export interface DeviceInfoOptions {
  uniqueIdentifier: string;
  name: string;
  localizedModelName?: string;
  systemBuildVersion?: string;
  applicationBundleIdentifier?: string;
  protocolVersion?: number;
}

export class MRPMessage {
  static async deviceInfo(options: DeviceInfoOptions): Promise<Buffer> {
    const root = await loadRoot();
    const ProtocolMessage = root.lookupType('ProtocolMessage');
    const DeviceInfoMessage = root.lookupType('DeviceInfoMessage');

    const deviceInfoPayload = DeviceInfoMessage.create({
      uniqueIdentifier: options.uniqueIdentifier,
      name: options.name,
      localizedModelName: options.localizedModelName ?? 'Node.js',
      systemBuildVersion: options.systemBuildVersion ?? '1.0.0',
      applicationBundleIdentifier:
        options.applicationBundleIdentifier ?? 'com.node-atv.remote',
      protocolVersion: options.protocolVersion ?? 1,
    });

    const message = ProtocolMessage.create({
      type: MessageType.DeviceInfo,
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
}
