/**
 * Public entry point for node-atv: re-exports device discovery, the AppleTV
 * client selection, pairing, Companion, AirPlay/MRP, DMAP and legacy RAOP APIs.
 */

export { scan } from './discovery.js';
export { AppleTV, Key, TextInputActionType, ShuffleState, RepeatState, PowerState, KeyboardFocusState, TouchAction, INPUT_ACTIONS } from './appletv.js';
export type { KeyboardInfo, TextInputEvent, CompanionEvent, App, UserAccount, ConnectOptions, Feature, FeatureAvailability, InputAction, OutputDevice } from './appletv.js';
export { CompanionConnection } from './companion/connection.js';
export { PairSetup } from './auth/pair-setup.js';
export { CompanionPairSetup } from './companion/pair-setup.js';
export { CompanionSession } from './companion/companion-session.js';
export { opackEncode, opackDecode, OpackFloat } from './companion/opack.js';
export type { OpackValue, OpackDict } from './companion/opack.js';
export { FrameType, encodeFrame, parseFrames } from './companion/framing.js';
export type { Frame } from './companion/framing.js';
export { Credentials, parseCredentials } from './credentials.js';
export { NowPlayingInfo, PlaybackState } from './now-playing-info.js';
export { SupportedCommand, Command } from './supported-command.js';
export { Message } from './message.js';
export { AirPlayConnection } from './connection.js';
export type { HAPCredentials } from './auth/types.js';
export type { ScanOptions, DiscoveredDevice, DiscoveredDeviceInfo } from './discovery.js';

export { LegacyMRPConnection } from './mrp/legacy-connection.js';
export { MRPConnection } from './mrp/connection.js';
export type { MRPDiagnostic } from './mrp/connection.js';

export { DmapClient } from './dmap/client.js';
export type { DmapCapability } from './dmap/client.js';
export { DmapPairing } from './dmap/pairing.js';
export type { DmapPairingOptions } from './dmap/pairing.js';
import { AppleTV } from './appletv.js';
import { DmapClient } from './dmap/client.js';
import type { DiscoveredDeviceInfo } from './discovery.js';

/** Prefer usable modern AirPlay, then enabled standalone MRP, then DMAP, then Companion-only; explicit DMAP never converts HAP credentials. */
export function createClient(info: DiscoveredDeviceInfo, protocol: 'airplay' | 'mrp'): AppleTV;
export function createClient(info: DiscoveredDeviceInfo, protocol: 'dmap'): DmapClient;
export function createClient(info: DiscoveredDeviceInfo): AppleTV | DmapClient;
export function createClient(info: DiscoveredDeviceInfo, protocol?: 'airplay' | 'mrp' | 'dmap'): AppleTV | DmapClient {
  if (protocol !== undefined && !['airplay', 'mrp', 'dmap'].includes(protocol)) throw new Error('Unsupported protocol');
  // AppleTV generations 1-3 advertise legacy AirPlay, not the AirPlay 2 MRP tunnel.
  const modernAirPlay = !!info.port && !/^AppleTV[1-3],/.test(info.model);
  const selected = protocol ?? (modernAirPlay ? 'airplay' : info.mrpPort && info.mrpEnabled !== false ? 'mrp' : info.dmapPort ? 'dmap' : 'airplay');
  if (selected === 'dmap') return new DmapClient(info);
  if (selected === 'mrp') {
    if (!info.mrpPort || info.mrpEnabled === false) throw new Error('No enabled standalone MRP port available');
    return new AppleTV({ ...info, port: 0 });
  }
  // A Companion-only device still gets an AppleTV for connectCompanion(); its MRP methods fail before any socket opens.
  if (!info.port && !(protocol === undefined && info.companionPort)) throw new Error('No AirPlay port available');
  return new AppleTV(info);
}

export { AirPlayPlaybackSession } from './airplay-playback.js';
export type { AirPlayPlaybackStatus } from './airplay-playback.js';

/** One-shot PCM audio streaming to legacy RAOP receivers or, with HAP `credentials`, AirPlay 2 realtime receivers (experimental, #22). */
export { RaopStream } from './raop/stream.js';
export type { RaopMetadata, RaopStreamOptions, RaopPcmSource } from './raop/stream.js';
/** Validate a PCM16 stereo 44.1 kHz WAV Readable and yield its audio payload as a RaopStream source. */
export { wavPcm } from './raop/wav.js';
/** Legacy AirPlay PIN pair-setup for RAOP receivers; yields the clientId and secret 32-byte seed used as `legacySeed`. */
export { LegacyPairSetup } from './auth/legacy-pair-setup.js';
export type { LegacyAirPlayCredentials } from './auth/legacy-pair-setup.js';
