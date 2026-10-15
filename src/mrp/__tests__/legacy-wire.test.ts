/** Synthetic legacy peer verifies the real CryptoPairing exchange and encrypted protobuf framing. */
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, diffieHellman, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { SRP, SrpServer } from 'fast-srp-hap';
import * as transport from '../../connection.js';
import { LegacyMRPConnection } from '../legacy-connection.js';
import { AppleTV } from '../../appletv.js';
import { Credentials } from '../../credentials.js';
import { MRPMessage, MessageType } from '../messages.js';
import { decodeVarint, encodeVarint } from '../../util/data-stream.js';
import { tlvEncode, tlvDecode, TlvTag } from '../../util/tlv.js';
import { hkdfSha512, encryptChaCha20, decryptChaCha20, generateNonce } from '../../util/crypto.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, generateKeyPairSync: vi.fn(crypto.generateKeyPairSync) };
});

afterEach(() => vi.restoreAllMocks());

it('verifies legacy credentials then sends encrypted MRP over an IPv6 endpoint', async () => {
  const server = generateKeyPairSync('ed25519');
  const client = generateKeyPairSync('ed25519');
  const ephemeral = generateKeyPairSync('x25519');
  const raw = (key: KeyObject) => Buffer.from(key.export({ type: 'spki', format: 'der' }).subarray(-32));
  const credentials = new Credentials({ clientId: 'client', clientLTSK: Buffer.from(client.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)), clientLTPK: raw(client.publicKey), serverId: 'server', serverLTPK: raw(server.publicKey) });
  let secret: Buffer;
  let session: Buffer;
  let readKey: Buffer | undefined;
  let writeKey: Buffer | undefined;
  let counter = 0n;
  const types: number[] = [];
  let proofVerified = false;
  const socket = new EventEmitter() as EventEmitter & { write: (data: Buffer, cb: (error?: Error) => void) => void; destroy: () => void };
  socket.destroy = () => {};
  const respond = (data: Buffer) => {
    const frame = Buffer.concat([encodeVarint(data.length), data]);
    // Split a varint/payload over independent reads, with two messages coalesced later.
    socket.emit('data', frame.subarray(0, 1));
    socket.emit('data', frame.subarray(1));
  };
  socket.write = (frame, cb) => {
    void (async () => {
      const { value, bytesRead } = decodeVarint(frame);
      let payload = frame.subarray(bytesRead);
      expect(payload.length).toBe(value);
      if (readKey) payload = decryptChaCha20(readKey, generateNonce(counter++), payload.subarray(0, -16), payload.subarray(-16), Buffer.alloc(0));
      const message = await MRPMessage.decode(payload);
      types.push(message.type as number);
      if (message.type === MessageType.DeviceInfo) respond(await MRPMessage.deviceInfo({ uniqueIdentifier: 'server', name: 'Peer' }));
      if (message.type === MessageType.CryptoPairing) {
        const data = tlvDecode(Buffer.from((message['.cryptoPairingMessage'] as { pairingData: Buffer }).pairingData));
        if (data[TlvTag.SeqNo]![0] === 1) {
          const clientPublic = data[TlvTag.PublicKey]!;
          secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), clientPublic]), format: 'der', type: 'spki' }) });
          session = await hkdfSha512(secret, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', 32);
          const serverPublic = raw(ephemeral.publicKey);
          const signature = sign(null, Buffer.concat([serverPublic, Buffer.from('server'), clientPublic]), server.privateKey);
          const sealed = encryptChaCha20(session, Buffer.concat([Buffer.alloc(4), Buffer.from('PV-Msg02')]), tlvEncode({ [TlvTag.Identifier]: Buffer.from('server'), [TlvTag.Signature]: signature }), Buffer.alloc(0));
          respond(await MRPMessage.cryptoPairing(tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.PublicKey]: serverPublic, [TlvTag.EncryptedData]: Buffer.concat([sealed.ciphertext, sealed.tag]) })));
          (socket as unknown as { clientPublic: Buffer }).clientPublic = clientPublic;
        } else {
          const encrypted = data[TlvTag.EncryptedData]!;
          const inner = tlvDecode(decryptChaCha20(session!, Buffer.concat([Buffer.alloc(4), Buffer.from('PV-Msg03')]), encrypted.subarray(0, -16), encrypted.subarray(-16), Buffer.alloc(0)));
          proofVerified = verify(null, Buffer.concat([(socket as unknown as { clientPublic: Buffer }).clientPublic, inner[TlvTag.Identifier]!, raw(ephemeral.publicKey)]), client.publicKey, inner[TlvTag.Signature]!);
          readKey = await hkdfSha512(secret!, 'MediaRemote-Salt', 'MediaRemote-Write-Encryption-Key', 32);
          writeKey = await hkdfSha512(secret!, 'MediaRemote-Salt', 'MediaRemote-Read-Encryption-Key', 32);
          const m4 = await MRPMessage.cryptoPairing(tlvEncode({ [TlvTag.SeqNo]: Buffer.from([4]) }));
          const update = encryptChaCha20(writeKey, generateNonce(0n), await MRPMessage.sendCommand(MessageType.SetState), Buffer.alloc(0));
          const encryptedUpdate = Buffer.concat([update.ciphertext, update.tag]);
          socket.emit('data', Buffer.concat([encodeVarint(m4.length), m4, encodeVarint(encryptedUpdate.length), encryptedUpdate]));
        }
      }
      cb();
    })().catch((error) => cb(error));
  };
  const connect = vi.spyOn(transport, 'connectSocket').mockResolvedValue(socket as unknown as Socket);
  const atv = new AppleTV({ name: 'Legacy', address: 'fd00::1', mrpAddress: 'fd00::2', mrpPort: 49152, port: 0, deviceId: 'id', model: 'AppleTV' });
  const incoming: number[] = [];
  atv.on('message', (message: { type: number }) => incoming.push(message.type));
  await atv.connect(credentials);
  expect(incoming).toContain(MessageType.SetState);
  expect(connect).toHaveBeenCalledWith('fd00::2', 49152, 5000, expect.any(AbortSignal));
  expect(proofVerified).toBe(true);
  expect(types).toEqual([15, 34, 34, 38, 16, 24]);
  expect(writeKey).toHaveLength(32);
  await atv.close();
});

it('pairs through DeviceInfo and CryptoPairing M1-M6 with one controller keypair', async () => {
  vi.mocked(generateKeyPairSync).mockClear();
  const salt = Buffer.alloc(16, 7);
  const server = new SrpServer(SRP.params.hap, salt, Buffer.from('Pair-Setup'), Buffer.from('1234'), Buffer.alloc(32, 5));
  const steps: number[] = [];
  let clientIdentity: Buffer | undefined;
  let deviceInfoIdentity: unknown;
  const socket = new EventEmitter() as EventEmitter & { write: (data: Buffer, cb: (error?: Error) => void) => void; destroy: () => void };
  const destroy = vi.fn();
  socket.destroy = destroy;
  socket.write = (frame, cb) => {
    void (async () => {
      const { bytesRead } = decodeVarint(frame);
      const message = await MRPMessage.decode(frame.subarray(bytesRead));
      let response: Buffer;
      if (message.type === MessageType.DeviceInfo) {
        deviceInfoIdentity = (message['.deviceInfoMessage'] as { uniqueIdentifier?: string }).uniqueIdentifier;
        response = await MRPMessage.deviceInfo({ uniqueIdentifier: 'peer', name: 'Peer' });
      } else {
        const crypto = message['.cryptoPairingMessage'] as { pairingData: Buffer; state: number };
        const data = tlvDecode(Buffer.from(crypto.pairingData));
        const step = data[TlvTag.SeqNo]![0];
        steps.push(step);
        expect(crypto.state).toBe(step === 1 ? 2 : 0);
        let reply: Buffer;
        if (step === 1) {
          reply = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.Salt]: salt, [TlvTag.PublicKey]: server.computeB() });
        } else if (step === 3) {
          server.setA(data[TlvTag.PublicKey]!);
          server.checkM1(data[TlvTag.Proof]!);
          reply = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([4]), [TlvTag.Proof]: server.computeM2() });
        } else {
          const key = await hkdfSha512(server.computeK(), 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info', 32);
          const encrypted = data[TlvTag.EncryptedData]!;
          const inner = tlvDecode(decryptChaCha20(key, Buffer.concat([Buffer.alloc(4), Buffer.from('PS-Msg05')]), encrypted.subarray(0, -16), encrypted.subarray(-16), Buffer.alloc(0)));
          clientIdentity = inner[TlvTag.Identifier];
          const sealed = encryptChaCha20(key, Buffer.concat([Buffer.alloc(4), Buffer.from('PS-Msg06')]), tlvEncode({ [TlvTag.Identifier]: Buffer.from('peer'), [TlvTag.PublicKey]: Buffer.alloc(32, 9) }), Buffer.alloc(0));
          reply = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([6]), [TlvTag.EncryptedData]: Buffer.concat([sealed.ciphertext, sealed.tag]) });
        }
        response = await MRPMessage.cryptoPairing(reply);
      }
      socket.emit('data', Buffer.concat([encodeVarint(response.length), response]));
      cb();
    })().catch((error) => cb(error));
  };
  vi.spyOn(transport, 'connectSocket').mockResolvedValue(socket as unknown as Socket);
  const atv = new AppleTV({ name: 'Old', address: 'fd00::1', port: 0, mrpPort: 49152, deviceId: 'peer', model: 'AppleTV' });
  const setup = await atv.startPairing();
  expect(steps).toEqual([1]);
  const result = await setup.finish('1234');
  expect(steps).toEqual([1, 3, 5]);
  expect(result.clientId).toBe(clientIdentity!.toString());
  expect(deviceInfoIdentity).toBe(result.clientId);
  expect(result.serverId).toBe('peer');
  expect(result.serverLTPK).toEqual(Buffer.alloc(32, 9));
  expect(destroy).toHaveBeenCalledOnce();
  expect(vi.mocked(generateKeyPairSync).mock.calls.map(([algorithm]) => algorithm)).toEqual(['ed25519']);
}, 20000); // Real SRP-3072 math: ~2 s alone, several times that under a parallel full-suite run.

it('does not select disabled legacy MRP advertisements', async () => {
  const legacy = vi.spyOn(LegacyMRPConnection.prototype, 'connect').mockResolvedValue();
  const airplay = vi.spyOn(transport.AirPlayConnection.prototype, 'connect').mockResolvedValue();
  const credentials = new Credentials({ clientId: 'test', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32), serverId: 'server' });
  await new AppleTV({ name: 'New', address: 'fd00::1', port: 7000, mrpPort: 49152, mrpEnabled: false, deviceId: 'id', model: 'AppleTV' }).connect(credentials);
  expect(airplay).toHaveBeenCalledOnce();
  expect(legacy).not.toHaveBeenCalled();
});
