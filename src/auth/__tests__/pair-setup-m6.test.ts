/**
 * Pair-setup M6 through `sendM5` on the AirPlay and Companion flavours: the credentials from a
 * valid M6, the labelled error for each missing or malformed field, and signature rejection.
 * The AirPlay flavour passes no label, so it also proves the default; a separate case proves the
 * legacy MRP connection passes its own.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { PairSetup } from '../pair-setup.js';
import { CompanionPairSetup } from '../../companion/pair-setup.js';
import { LegacyMRPConnection } from '../../mrp/legacy-connection.js';
import { TlvTag, tlvEncode, type TlvData } from '../../util/tlv.js';
import { hkdfSha512, encryptChaCha20 } from '../../util/crypto.js';
import type { HAPCredentials } from '../types.js';

const sessionKey = Buffer.alloc(64, 7);
const accessoryId = Buffer.from('AA:BB:CC:DD:EE:FF');
const signatureFailure = 'accessory signature verification failed; start pairing again, and if it keeps failing report the Apple TV model and tvOS version';

type M6Fields = (signature: Buffer, ltpk: Buffer) => TlvData;

function accessoryKeys(): { privateKey: KeyObject; raw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, raw: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
}

/** Build the M6 a real Apple TV sends: its identity, signed with its long-term key, then encrypted. */
async function buildM6(fields: M6Fields, signedId: Buffer = accessoryId): Promise<{ m6: Buffer; ltpk: Buffer }> {
  const { privateKey, raw } = accessoryKeys();
  const accessoryX = await hkdfSha512(sessionKey, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info', 32);
  const signature = sign(null, Buffer.concat([accessoryX, signedId, raw]), privateKey);
  const key = await hkdfSha512(sessionKey, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info', 32);
  const nonce = Buffer.alloc(12, 0);
  nonce.write('PS-Msg06', 4);
  const { ciphertext, tag } = encryptChaCha20(key, nonce, tlvEncode(fields(signature, raw)), Buffer.alloc(0));
  return { m6: tlvEncode({ [TlvTag.SeqNo]: Buffer.from([6]), [TlvTag.EncryptedData]: Buffer.concat([ciphertext, tag]) }), ltpk: raw };
}

/** Run M5 on each pair-setup flavour, answering with the given M6. The second column is its error label. */
const flavours: Array<[string, string, (m6: Buffer) => Promise<{ serverLTPK: Buffer; serverId: string }>]> = [
  ['AirPlay', 'AirPlay PS M6', (m6) => {
    const pair = new PairSetup('127.0.0.1', 7000, { post: () => Promise.resolve(m6), destroy: () => {} });
    (pair as unknown as { sessionKey: Buffer }).sessionKey = sessionKey;
    return pair.sendM5();
  }],
  ['Companion', 'Companion PS M6', (m6) => {
    const pair = new CompanionPairSetup('127.0.0.1', 49153);
    const internals = pair as unknown as {
      sessionKey: Buffer;
      sendPairingData(data: Buffer): void;
      receivePairingData(): Promise<Buffer>;
    };
    internals.sessionKey = sessionKey;
    internals.sendPairingData = () => {};
    internals.receivePairingData = () => Promise.resolve(m6);
    return pair.sendM5();
  }],
];

/** M6 bodies with exactly one defect, and the error each must produce after the label. */
const malformed: Array<[string, M6Fields, string]> = [
  ['no Identifier', (signature, raw) => ({ [TlvTag.PublicKey]: raw, [TlvTag.Signature]: signature }), 'missing Identifier'],
  ['no PublicKey', (signature) => ({ [TlvTag.Identifier]: accessoryId, [TlvTag.Signature]: signature }), 'missing a 32-byte PublicKey'],
  ['a 31-byte PublicKey', (signature, raw) => ({ [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw.subarray(1), [TlvTag.Signature]: signature }), 'missing a 32-byte PublicKey'],
  ['no Signature', (_signature, raw) => ({ [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw }), 'missing a 64-byte Signature'],
  ['a 63-byte Signature', (signature, raw) => ({ [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw, [TlvTag.Signature]: signature.subarray(1) }), 'missing a 64-byte Signature'],
];

describe.each(flavours)('%s pair-setup M6 identity', (_name, label, runM5) => {
  it('accepts an M6 signed by the key it carries', async () => {
    const { m6, ltpk } = await buildM6((signature, raw) => ({
      [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw, [TlvTag.Signature]: signature,
    }));
    const credentials = await runM5(m6);
    expect(credentials.serverLTPK.equals(ltpk)).toBe(true);
    expect(credentials.serverId).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('rejects an M6 whose signature was altered', async () => {
    const { m6 } = await buildM6((signature, raw) => {
      const altered = Buffer.from(signature);
      altered[0] ^= 1;
      return { [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw, [TlvTag.Signature]: altered };
    });
    await expect(runM5(m6)).rejects.toHaveProperty('message', `${label} ${signatureFailure}`);
  });

  it('rejects an M6 that carries a different key than the one that signed it', async () => {
    const other = accessoryKeys().raw;
    const { m6 } = await buildM6((signature) => ({
      [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: other, [TlvTag.Signature]: signature,
    }));
    await expect(runM5(m6)).rejects.toHaveProperty('message', `${label} ${signatureFailure}`);
  });

  it.each(malformed)('rejects an M6 with %s', async (_defect, fields, message) => {
    const { m6 } = await buildM6(fields);
    await expect(runM5(m6)).rejects.toHaveProperty('message', `${label} ${message}`);
  });

  // Signed over the empty value, so only the Identifier guard stops it reaching the credentials.
  it('rejects an M6 with an empty Identifier', async () => {
    const empty = Buffer.alloc(0);
    const { m6 } = await buildM6((signature, raw) => ({
      [TlvTag.Identifier]: empty, [TlvTag.PublicKey]: raw, [TlvTag.Signature]: signature,
    }), empty);
    await expect(runM5(m6)).rejects.toHaveProperty('message', `${label} missing Identifier`);
  });

  it('rejects an M6 without EncryptedData and reports the device error', async () => {
    const m6 = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([6]), [TlvTag.Error]: Buffer.from([2]) });
    await expect(runM5(m6)).rejects.toHaveProperty('message', `${label} missing EncryptedData (error=2)`);
  });

  it('rejects an M6 without EncryptedData or a device error', async () => {
    const m6 = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([6]) });
    await expect(runM5(m6)).rejects.toHaveProperty('message', `${label} missing EncryptedData (error=none)`);
  });
});

it('labels M6 errors MRP PS M6 on a pairing started by the legacy MRP connection', async () => {
  const { m6 } = await buildM6((signature, raw) => ({ [TlvTag.PublicKey]: raw, [TlvTag.Signature]: signature }));
  const connection = new LegacyMRPConnection('127.0.0.1', 49152, {} as HAPCredentials);
  const internals = connection as unknown as {
    open(): Promise<void>;
    waitForMRPMessage(): Promise<void>;
    sendMRPMessage(): Promise<void>;
    pairingTransport(): { post(): Promise<Buffer>; destroy(): void };
  };
  internals.open = () => Promise.resolve();
  internals.waitForMRPMessage = () => Promise.resolve();
  internals.sendMRPMessage = () => Promise.resolve();
  // startPairing caches this first reply as M2 and serves it to the next post, which is M5's.
  internals.pairingTransport = () => ({ post: () => Promise.resolve(m6), destroy: () => {} });
  const setup = await connection.startPairing();
  (setup as unknown as { sessionKey: Buffer }).sessionKey = sessionKey;
  await expect(setup.sendM5()).rejects.toHaveProperty('message', 'MRP PS M6 missing Identifier');
});
