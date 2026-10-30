/**
 * Loopback AirPlay 2 realtime-audio receiver shared by the airplay2 setup and stream tests:
 * retained HAP pair-verify or transient SRP pairing on the RTSP socket, HAP-encrypted RTSP
 * afterwards, an encrypted event channel (Events-Salt) that sends one request and records the
 * acknowledgement, and UDP data/control sockets that collect what the sender transmits. Synthetic
 * keys only; no device involved.
 */
import { createServer, type Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { generateKeyPairSync, diffieHellman, createPublicKey, createDecipheriv, sign, verify, type KeyObject } from 'node:crypto';
import { SRP, SrpServer } from 'fast-srp-hap';
import { setTimeout as delay } from 'node:timers/promises';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { tlvEncode, tlvDecode, TlvTag } from '../../util/tlv.js';
import { encryptChaCha20, decryptChaCha20, hkdfSha512 } from '../../util/crypto.js';
import { HAPSession } from '../../util/hap-session.js';
import { parseHTTPMessage } from '../../connection.js';
import type { HAPCredentials } from '../../auth/types.js';

export interface ReceivedRequest { startLine: string; method: string; uri: string; headers: Record<string, string>; body: Buffer; encrypted: boolean }

export interface ReceiverOptions {
  /** Replaces the base SETUP `eventPort` (for example a port nobody listens on). */
  eventPort?: number;
  /** Merged into the stream SETUP reply's `streams[0]` (for example invalid ports). */
  stream?: Record<string, unknown>;
  /** Sent as the `Session` header on the stream SETUP reply. */
  session?: string;
  /** Leave `/feedback` requests unanswered. */
  holdFeedback?: boolean;
  /** Replaces the base SETUP reply body (for example something that is not a binary-plist dictionary). */
  baseReply?: Buffer;
  /** Sent as the `Audio-Latency` header on the RECORD reply. */
  recordLatency?: string;
  /** Like an Apple TV: before replying to the base SETUP, send an NTP timing request to its `timingPort` and wait for the answer. */
  timingFirst?: boolean;
  /** Close the event channel when TEARDOWN arrives, before replying to it (an Apple TV does this). */
  closeEventsOnTeardown?: boolean;
  /** Replaces the transient pair-setup M2 TLV reply. */
  transientM2?: Buffer;
  /** Replaces the transient pair-setup M4 TLV reply after checking the client proof. */
  transientM4?: Buffer;
}

const raw = (key: KeyObject) => Buffer.from(key.export({ format: 'der', type: 'spki' }).subarray(-32));
const nonce = (label: string) => { const value = Buffer.alloc(12); value.write(label, 4); return value; };

export async function airplay2Receiver(options: ReceiverOptions = {}) {
  const serverKeys = generateKeyPairSync('ed25519');
  const clientKeys = generateKeyPairSync('ed25519');
  const credentials: HAPCredentials = { clientId: 'synthetic-client', serverId: 'synthetic-server', clientLTPK: raw(clientKeys.publicKey), clientLTSK: Buffer.from(clientKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)), serverLTPK: raw(serverKeys.publicKey) };
  const requests: ReceivedRequest[] = [];
  const sockets = new Set<Socket>();
  const audioPackets: Buffer[] = []; const controlPackets: Buffer[] = [];
  const state = { eventConnected: false, eventAcknowledged: false, eventClosed: false, controlClosed: false, timingAnswered: false, senderControlPort: 0 };
  let eventCipher: HAPSession | undefined;
  const eventSockets = new Set<Socket>();

  const audio = createSocket('udp4'); const control = createSocket('udp4');
  for (const socket of [audio, control]) { socket.bind(0, '127.0.0.1'); await once(socket, 'listening'); }
  audio.on('message', packet => {
    audioPackets.push(packet);
    // Like the legacy receiver, request one retransmission of the first packet immediately.
    if (audioPackets.length === 1) control.send(Buffer.from([0x80, 0xd5, 0, 1, packet[2], packet[3], 0, 1]), state.senderControlPort, '127.0.0.1');
  });
  control.on('message', packet => { if (packet[1] !== 0xd3) controlPackets.push(packet); });

  const events = createServer(socket => {
    state.eventConnected = true; sockets.add(socket); eventSockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); state.eventClosed = true; });
    let buffer = Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      const decoded = eventCipher!.decryptAvailable(buffer); buffer = Buffer.from(decoded.rest);
      if (decoded.plaintext.toString().startsWith('RTSP/1.0 200 OK') && decoded.plaintext.includes('CSeq: 73')) state.eventAcknowledged = true;
    });
    socket.write(eventCipher!.encrypt(Buffer.from('POST /event RTSP/1.0\r\nCSeq: 73\r\nContent-Length: 0\r\n\r\n')));
  });
  events.listen(0, '127.0.0.1'); await once(events, 'listening');

  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); state.controlClosed = true; });
    let encrypted = Buffer.alloc(0); let plain = Buffer.alloc(0);
    let session: HAPSession | undefined;
    let secret: Buffer | undefined; let ephemeral: Buffer | undefined; let clientEphemeral: Buffer | undefined;
    let transientSrp: SrpServer | undefined;
    const write = (message: Buffer) => {
      const wire = session ? session.encrypt(message) : message;
      // Split replies to exercise streaming buffers rather than packet assumptions.
      socket.write(wire.subarray(0, 5)); socket.write(wire.subarray(5));
    };
    socket.on('data', async (data: Buffer) => {
      if (session) {
        encrypted = Buffer.concat([encrypted, data]);
        const decoded = session.decryptAvailable(encrypted); encrypted = Buffer.from(decoded.rest);
        plain = Buffer.concat([plain, decoded.plaintext]);
      } else plain = Buffer.concat([plain, data]);
      let message;
      while ((message = parseHTTPMessage(plain))) {
        plain = Buffer.from(plain.subarray(message.totalSize));
        const [method, uri, protocol] = message.startLine.split(' ');
        const { headers, body } = message;
        requests.push({ startLine: message.startLine, method, uri, headers, body: Buffer.from(body), encrypted: !!session });
        const reply = (payload: Buffer = Buffer.alloc(0), extra = '', code = '200 OK') => write(Buffer.concat([
          Buffer.from(`${protocol} ${code}\r\n${headers.cseq ? `CSeq: ${headers.cseq}\r\n` : ''}${extra}Content-Length: ${payload.length}\r\n\r\n`), payload]));
        if (uri === '/pair-pin-start') { reply(); continue; }
        if (uri === '/pair-setup') {
          const tlv = tlvDecode(body);
          if (tlv[TlvTag.SeqNo]?.[0] === 1) {
            const salt = Buffer.alloc(16, 0x5a);
            transientSrp = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from(String(3939)), Buffer.alloc(32, 0x6b));
            reply(options.transientM2 ?? tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.Salt]: salt, [TlvTag.PublicKey]: transientSrp.computeB() }));
          } else if (tlv[TlvTag.SeqNo]?.[0] === 3 && transientSrp) {
            transientSrp.setA(tlv[TlvTag.PublicKey]!);
            transientSrp.checkM1(tlv[TlvTag.Proof]!);
            if (options.transientM4) { reply(options.transientM4); continue; }
            secret = transientSrp.computeK();
            const verified = new HAPSession(await hkdfSha512(secret, 'Control-Salt', 'Control-Read-Encryption-Key', 32), await hkdfSha512(secret, 'Control-Salt', 'Control-Write-Encryption-Key', 32));
            eventCipher = new HAPSession(await hkdfSha512(secret, 'Events-Salt', 'Events-Write-Encryption-Key', 32), await hkdfSha512(secret, 'Events-Salt', 'Events-Read-Encryption-Key', 32));
            reply(tlvEncode({ [TlvTag.SeqNo]: Buffer.from([4]), [TlvTag.Proof]: transientSrp.computeM2() }));
            session = verified;
          } else reply(tlvEncode({ [TlvTag.Error]: Buffer.from([2]) }), '', '470 Connection Authorization Required');
          continue;
        }
        if (uri === '/pair-verify') {
          const tlv = tlvDecode(body);
          if (tlv[TlvTag.SeqNo]![0] === 1) {
            const keys = generateKeyPairSync('x25519');
            ephemeral = raw(keys.publicKey); clientEphemeral = tlv[TlvTag.PublicKey]!;
            secret = diffieHellman({ privateKey: keys.privateKey, publicKey: createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), clientEphemeral]) }) });
            const key = await hkdfSha512(secret, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', 32);
            const signature = sign(null, Buffer.concat([ephemeral, Buffer.from(credentials.serverId), clientEphemeral]), serverKeys.privateKey);
            const sealed = encryptChaCha20(key, nonce('PV-Msg02'), tlvEncode({ [TlvTag.Identifier]: Buffer.from(credentials.serverId), [TlvTag.Signature]: signature }), Buffer.alloc(0));
            reply(tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.PublicKey]: ephemeral, [TlvTag.EncryptedData]: Buffer.concat([sealed.ciphertext, sealed.tag]) }));
          } else {
            const key = await hkdfSha512(secret!, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', 32);
            const sealed = tlv[TlvTag.EncryptedData]!;
            const proof = tlvDecode(decryptChaCha20(key, nonce('PV-Msg03'), sealed.subarray(0, -16), sealed.subarray(-16), Buffer.alloc(0)));
            if (!verify(null, Buffer.concat([clientEphemeral!, proof[TlvTag.Identifier]!, ephemeral!]), clientKeys.publicKey, proof[TlvTag.Signature]!)) { reply(tlvEncode({ [TlvTag.Error]: Buffer.from([2]) }), '', '470 Connection Authorization Required'); continue; }
            const verified = new HAPSession(await hkdfSha512(secret!, 'Control-Salt', 'Control-Read-Encryption-Key', 32), await hkdfSha512(secret!, 'Control-Salt', 'Control-Write-Encryption-Key', 32));
            eventCipher = new HAPSession(await hkdfSha512(secret!, 'Events-Salt', 'Events-Write-Encryption-Key', 32), await hkdfSha512(secret!, 'Events-Salt', 'Events-Read-Encryption-Key', 32));
            reply(tlvEncode({ [TlvTag.SeqNo]: Buffer.from([4]) }));
            session = verified;
          }
          continue;
        }
        if (options.holdFeedback && uri === '/feedback') continue;
        if (method === 'SETUP') {
          const plist = parseBuffer(body)[0] as Record<string, unknown>;
          if (!plist.streams && options.timingFirst) {
            const request = Buffer.alloc(32); request[0] = 0x80; request[1] = 0xd2; request.writeUInt16BE(7, 2);
            const answered = once(control, 'message');
            control.send(request, plist.timingPort as number, '127.0.0.1');
            await answered; state.timingAnswered = true;
          }
          if (!plist.streams) { reply(options.baseReply ?? bplistCreator({ eventPort: options.eventPort ?? (events.address() as { port: number }).port }), 'Content-Type: application/x-apple-binary-plist\r\n'); continue; }
          state.senderControlPort = ((plist.streams as Record<string, unknown>[])[0].controlPort as number);
          // bplist-creator cannot encode undefined, so an undefined override removes the field.
          const stream = Object.fromEntries(Object.entries({ type: 0x60, dataPort: audio.address().port, controlPort: control.address().port, ...options.stream }).filter(([, value]) => value !== undefined));
          reply(bplistCreator({ streams: [stream] }), `Content-Type: application/x-apple-binary-plist\r\n${options.session ? `Session: ${options.session}\r\n` : ''}`);
          continue;
        }
        if (method === 'TEARDOWN' && options.closeEventsOnTeardown) for (const socket of eventSockets) socket.destroy();
        if (method === 'RECORD' && options.recordLatency) { reply(undefined, `Audio-Latency: ${options.recordLatency}\r\n`); continue; }
        reply();
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');

  return {
    port: (server.address() as { port: number }).port, credentials, requests, audioPackets, controlPackets, state,
    /** Close the receiver side of every event connection. */
    closeEvents: () => { for (const socket of eventSockets) socket.destroy(); },
    /** Reset every event connection (TCP RST), so the sender's event socket emits `error`. */
    resetEvents: () => { for (const socket of eventSockets) socket.resetAndDestroy(); },
    /** Decoded bplist bodies of the base and stream SETUP requests, in order. */
    setups: () => requests.filter(request => request.method === 'SETUP').map(request => parseBuffer(request.body)[0] as Record<string, unknown>),
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => events.close(() => resolve()))]);
      audio.close(); control.close();
    },
  };
}

/** Poll real time until `check` holds, or throw. */
export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (check()) return; await delay(2); }
  throw new Error('Loopback condition did not arrive');
}

/** A TCP port that refuses connections right now (bound then released). */
export async function closedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** Independently open a sealed AirPlay 2 audio packet: nonce from the trailer counter, AAD = RTP bytes 4..11. */
export function openSealed(packet: Buffer, key: Buffer): { payload: Buffer; counter: bigint } {
  const trailer = packet.subarray(-8);
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.concat([Buffer.alloc(4), trailer]), { authTagLength: 16 });
  decipher.setAAD(packet.subarray(4, 12), { plaintextLength: packet.length - 36 });
  decipher.setAuthTag(packet.subarray(-24, -8));
  return { payload: Buffer.concat([decipher.update(packet.subarray(12, -24)), decipher.final()]), counter: trailer.readBigUInt64LE() };
}
