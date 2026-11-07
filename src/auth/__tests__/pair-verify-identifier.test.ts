/**
 * Pair-verify must bind the accessory to the identifier stored at pair-setup (#132), in all three
 * implementations: PairVerify, AirPlayConnection and CompanionConnection. Every peer here holds the
 * private key for the stored LTPK, so its M2 is validly signed and only the identifier can reject
 * it. A mismatch is built by giving the client a stored `serverId` the peer does not present.
 * Loopback only, with synthetic keys.
 */
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { diffieHellman, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairVerify } from '../pair-verify.js';
import type { HAPCredentials } from '../types.js';
import { AirPlayConnection } from '../../connection.js';
import { CompanionConnection } from '../../companion/connection.js';
import { FrameType, encodeFrame, parseFrames } from '../../companion/framing.js';
import { opackDecode, opackEncode, type OpackDict } from '../../companion/opack.js';
import { airplay2Receiver, until } from '../../raop/__tests__/airplay2-receiver.js';
import { decryptChaCha20, encryptChaCha20, hkdfSha512, x25519PublicKeyFromRaw } from '../../util/crypto.js';
import { TlvTag, tlvDecode, tlvEncode, type TlvData } from '../../util/tlv.js';

const SERVER_MISMATCH = 'Server identifier does not match the paired accessory';
const COMPANION_MISMATCH = 'Companion server identifier does not match the paired accessory';
const OTHER_ACCESSORY = 'a-different-accessory';

const raw = (key: KeyObject) => Buffer.from(key.export({ format: 'der', type: 'spki' }).subarray(-32));
const nonce = (label: string) => { const value = Buffer.alloc(12); value.write(label, 4); return value; };

/** Companion peer that completes pair-verify, presenting `credentials.serverId`, then idles. */
async function companionPeer() {
  const accessory = generateKeyPairSync('ed25519');
  const controller = generateKeyPairSync('ed25519');
  const credentials: HAPCredentials = {
    clientId: 'synthetic-client',
    serverId: 'synthetic-server',
    clientLTPK: raw(controller.publicKey),
    clientLTSK: Buffer.from(controller.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)),
    serverLTPK: raw(accessory.publicKey),
  };
  const sequence: number[] = [];
  const state = { socketClosed: false };
  const sockets = new Set<Socket>();

  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); state.socketClosed = true; });
    const ephemeral = generateKeyPairSync('x25519');
    const ephemeralPublic = raw(ephemeral.publicKey);
    const reply = (tlv: TlvData) => socket.write(encodeFrame(FrameType.PV_Next, opackEncode(new Map([['_pd', tlvEncode(tlv)]]))));
    let buffer: Buffer = Buffer.alloc(0);
    let clientPublic: Buffer | undefined;
    let sessionKey: Buffer | undefined;

    socket.on('data', async (data: Buffer) => {
      const { frames, remainder } = parseFrames(Buffer.concat([buffer, data]));
      buffer = remainder;
      for (const frame of frames) {
        const tlv = tlvDecode((opackDecode(frame.payload) as OpackDict).get('_pd') as Buffer);
        const step = tlv[TlvTag.SeqNo]![0];
        sequence.push(step);
        if (step === 1) {
          clientPublic = tlv[TlvTag.PublicKey]!;
          const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519PublicKeyFromRaw(clientPublic) });
          sessionKey = await hkdfSha512(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info', 32);
          const identifier = Buffer.from(credentials.serverId);
          const signature = sign(null, Buffer.concat([ephemeralPublic, identifier, clientPublic]), accessory.privateKey);
          const sealed = encryptChaCha20(sessionKey, nonce('PV-Msg02'), tlvEncode({ [TlvTag.Identifier]: identifier, [TlvTag.Signature]: signature }), Buffer.alloc(0));
          reply({ [TlvTag.SeqNo]: Buffer.from([2]), [TlvTag.PublicKey]: ephemeralPublic, [TlvTag.EncryptedData]: Buffer.concat([sealed.ciphertext, sealed.tag]) });
        } else {
          const sealed = tlv[TlvTag.EncryptedData]!;
          const proof = tlvDecode(decryptChaCha20(sessionKey!, nonce('PV-Msg03'), sealed.subarray(0, -16), sealed.subarray(-16), Buffer.alloc(0)));
          const proven = verify(null, Buffer.concat([clientPublic!, proof[TlvTag.Identifier]!, ephemeralPublic]), controller.publicKey, proof[TlvTag.Signature]!);
          reply(proven ? { [TlvTag.SeqNo]: Buffer.from([4]) } : { [TlvTag.Error]: Buffer.from([2]) });
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    port: (server.address() as { port: number }).port,
    credentials,
    sequence,
    state,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('AirPlay pair-verify identifier', () => {
  let receiver: Awaited<ReturnType<typeof airplay2Receiver>>;
  const pairVerifyRequests = () => receiver.requests.filter(request => request.uri === '/pair-verify');

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    receiver = await airplay2Receiver();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await receiver.close();
  });

  describe('PairVerify', () => {
    it('accepts the identifier stored at pair-setup', async () => {
      const keys = await new PairVerify('127.0.0.1', receiver.port, receiver.credentials).verify();

      expect(keys.outputKey).toHaveLength(32);
      expect(pairVerifyRequests()).toHaveLength(2);
    });

    it('rejects a validly signed M2 with a different identifier, before M3, and closes the carrier', async () => {
      const credentials = { ...receiver.credentials, serverId: OTHER_ACCESSORY };

      await expect(new PairVerify('127.0.0.1', receiver.port, credentials).verify())
        .rejects.toHaveProperty('message', SERVER_MISMATCH);

      expect(pairVerifyRequests()).toHaveLength(1);
      await until(() => receiver.state.controlClosed);
    });
  });

  describe('AirPlayConnection', () => {
    it('accepts the identifier stored at pair-setup and opens the encrypted session', async () => {
      const conn = new AirPlayConnection('127.0.0.1', receiver.port, receiver.credentials);
      // The receiver's data port is UDP, so stop at the MRP tunnel, which pair-verify does not reach.
      vi.spyOn(conn as any, 'setupDataChannel').mockResolvedValue(undefined);

      try {
        await conn.connect();

        expect(pairVerifyRequests()).toHaveLength(2);
        expect(receiver.requests.some(request => request.method === 'RECORD' && request.encrypted)).toBe(true);
      } finally {
        conn.close();
      }
    });

    it('rejects a validly signed M2 with a different identifier, before M3, and leaves no session', async () => {
      const conn = new AirPlayConnection('127.0.0.1', receiver.port, { ...receiver.credentials, serverId: OTHER_ACCESSORY });
      vi.spyOn(conn as any, 'setupDataChannel').mockResolvedValue(undefined);
      let closes = 0;
      conn.on('close', () => { closes++; });

      await expect(conn.connect()).rejects.toHaveProperty('message', SERVER_MISMATCH);

      expect(receiver.requests.map(request => request.uri)).toEqual(['/pair-verify']);
      expect(closes).toBe(1);
      expect((conn as any).socket).toBeUndefined();
      expect((conn as any).session).toBeUndefined();
      expect((conn as any).sharedSecret).toBeUndefined();
      await until(() => receiver.state.controlClosed);
    });
  });
});

describe('CompanionConnection pair-verify identifier', () => {
  let peer: Awaited<ReturnType<typeof companionPeer>>;

  beforeEach(async () => { peer = await companionPeer(); });
  afterEach(async () => { await peer.close(); });

  it('accepts the identifier stored at pair-setup and opens the encrypted session', async () => {
    const conn = new CompanionConnection('127.0.0.1', peer.port, peer.credentials);

    try {
      await conn.connect();

      expect(peer.sequence).toEqual([1, 3]);
      expect((conn as any).session).toBeDefined();
    } finally {
      conn.close();
    }
  });

  it('rejects a validly signed M2 with a different identifier, before M3, and leaves no session', async () => {
    const conn = new CompanionConnection('127.0.0.1', peer.port, { ...peer.credentials, serverId: OTHER_ACCESSORY });
    let closes = 0;
    conn.on('close', () => { closes++; });

    await expect(conn.connect()).rejects.toHaveProperty('message', COMPANION_MISMATCH);

    expect(peer.sequence).toEqual([1]);
    expect(closes).toBe(1);
    expect((conn as any).socket).toBeUndefined();
    expect(() => conn.sendMessage('test', new Map())).toThrow('not connected');
    await until(() => peer.state.socketClosed);
  });
});
