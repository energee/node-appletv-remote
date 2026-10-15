/**
 * AirPlay 2 realtime-audio setup on an existing RAOP RTSP connection: HAP pair-verify with stored
 * credentials, HAP-encrypted RTSP from then on, a base SETUP that yields the event port, the
 * encrypted event channel, and a stream SETUP for 44.1 kHz stereo PCM (`ct: 1`) sealed with a
 * random 32-byte key. `RaopStream` then runs RECORD/FLUSH and the shared packet loop (#22).
 * Field values follow the reference implementation and are unverified on hardware.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { PairVerify } from '../auth/pair-verify.js';
import type { HAPCredentials } from '../auth/types.js';
import { HAPSession } from '../util/hap-session.js';
import { openEventChannel } from '../util/event-channel.js';
import type { RtspClient } from './stream.js';

export interface AirPlay2Audio {
  /** Receiver UDP port for sealed audio packets (`dataPort`). */
  serverPort: number;
  /** Receiver UDP control port for sync packets and resend requests. */
  controlPort: number;
  /** The stream key (`shk`) every audio packet is sealed with; the caller zeroes it after teardown. */
  audioKey: Buffer;
  /** Encrypted event channel; the caller destroys it after TEARDOWN. */
  events: Socket;
  /** First token of the stream SETUP reply's `Session` header, if the receiver sent one (unvalidated). */
  session?: string;
}

const PLIST = { 'Content-Type': 'application/x-apple-binary-plist' };

/** Decode a binary-plist dictionary reply, or throw naming the request. */
function dictionary(body: Buffer, request: string): Record<string, unknown> {
  let value: unknown;
  try { value = parseBuffer(body)[0]; } catch { throw new Error(`Invalid AirPlay 2 ${request} reply`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid AirPlay 2 ${request} reply`);
  return value as Record<string, unknown>;
}

function port(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid AirPlay 2 ${name}`);
  return value;
}

/**
 * Authenticate and set up one realtime audio stream. `sessionId` must be the number already
 * passed to `client.setLocalUri` (it is sent as `streamConnectionID`); `localPorts` are the
 * sender's bound UDP timing and control ports.
 *
 * Event-channel errors, or the receiver closing it, destroy the RTSP socket so the client's
 * failure callback ends the stream. On any rejection the event channel is closed.
 *
 * @throws (rejects) when pair-verify fails (for example wrong credentials), a reply is not a
 * valid binary plist, `eventPort`/`dataPort`/`controlPort` is not an integer 1..65535, the
 * event connect fails, or `signal` aborts.
 */
export async function setupAirPlay2Audio(client: RtspClient, host: string, credentials: HAPCredentials,
  sessionId: number, localPorts: { timing: number; control: number }, signal: AbortSignal): Promise<AirPlay2Audio> {
  const keys = await new PairVerify(host, 0, credentials, {
    post: async (path, body) => (await client.request('POST', { 'X-Apple-HKP': '3', 'Content-Type': 'application/octet-stream' }, body, signal, 5000, path)).body,
    destroy() {}, // The RTSP connection stays open for the encrypted session.
  }).verify();
  let events: Socket | undefined;
  const lost = (error: Error) => client.socket.destroy(error);
  const closed = () => lost(new Error('AirPlay 2 event connection closed'));
  try {
    client.encryptWith(new HAPSession(keys.outputKey, keys.inputKey));
    const mac = randomBytes(6).toString('hex').match(/../g)!.join(':').toUpperCase();
    const base = await client.request('SETUP', PLIST, bplistCreator({
      deviceID: mac, macAddress: mac, sessionUUID: randomUUID().toUpperCase(), timingPort: localPorts.timing,
      timingProtocol: 'NTP', isMultiSelectAirPlay: true, groupContainsGroupLeader: false,
      model: 'iPhone14,3', name: 'Node ATV', osBuildVersion: '20F66', osName: 'iPhone OS', osVersion: '16.5',
      senderSupportsRelay: false, sourceVersion: '690.7.1', statsCollectionEnabled: false,
    }), signal);
    const eventPort = port(dictionary(base.body, 'SETUP').eventPort, 'eventPort');
    events = await openEventChannel(host, eventPort, keys.sharedSecret, lost, signal);
    events.on('error', lost); events.on('close', closed);
    const audioKey = randomBytes(32);
    const reply = await client.request('SETUP', PLIST, bplistCreator({ streams: [{
      type: 0x60, ct: 1, audioFormat: 0x800, spf: 352, sr: 44100, latencyMin: 11025, latencyMax: 88200,
      shk: audioKey, controlPort: localPorts.control, isMedia: true, audioMode: 'default',
      supportsDynamicStreamID: false, streamConnectionID: sessionId,
    }] }), signal);
    const streams = dictionary(reply.body, 'stream SETUP').streams;
    const stream = Array.isArray(streams) && streams[0] && typeof streams[0] === 'object' ? streams[0] as Record<string, unknown> : {};
    return {
      serverPort: port(stream.dataPort, 'dataPort'), controlPort: port(stream.controlPort, 'controlPort'),
      audioKey, events, session: reply.headers.session?.split(';')[0],
    };
  } catch (error) {
    if (events) { events.removeListener('close', closed); events.destroy(); }
    throw error;
  } finally { keys.sharedSecret.fill(0); }
}
