import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { PairSetup } from '../pair-setup.js';
import { CompanionPairSetup } from '../../companion/pair-setup.js';
import { TlvTag, tlvEncode, type TlvData } from '../../util/tlv.js';
import { hkdfSha512, encryptChaCha20 } from '../../util/crypto.js';

const sessionKey = Buffer.alloc(64, 7);
const accessoryId = Buffer.from('AA:BB:CC:DD:EE:FF');

function accessoryKeys(): { privateKey: KeyObject; raw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, raw: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
}

/** Build the M6 a real Apple TV sends: its identity, signed with its long-term key, then encrypted. */
async function buildM6(fields: (signature: Buffer, ltpk: Buffer) => TlvData): Promise<{ m6: Buffer; ltpk: Buffer }> {
  const { privateKey, raw } = accessoryKeys();
  const accessoryX = await hkdfSha512(sessionKey, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info', 32);
  const signature = sign(null, Buffer.concat([accessoryX, accessoryId, raw]), privateKey);
  const key = await hkdfSha512(sessionKey, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info', 32);
  const nonce = Buffer.alloc(12, 0);
  nonce.write('PS-Msg06', 4);
  const { ciphertext, tag } = encryptChaCha20(key, nonce, tlvEncode(fields(signature, raw)), Buffer.alloc(0));
  return { m6: tlvEncode({ [TlvTag.SeqNo]: Buffer.from([6]), [TlvTag.EncryptedData]: Buffer.concat([ciphertext, tag]) }), ltpk: raw };
}

/** Run M5 on each pair-setup flavour, answering with the given M6. */
const flavours: Array<[string, (m6: Buffer) => Promise<{ serverLTPK: Buffer; serverId: string }>]> = [
  ['AirPlay', (m6) => {
    const pair = new PairSetup('127.0.0.1', 7000, { post: () => Promise.resolve(m6), destroy: () => {} });
    (pair as unknown as { sessionKey: Buffer }).sessionKey = sessionKey;
    return pair.sendM5();
  }],
  ['Companion', (m6) => {
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

describe.each(flavours)('%s pair-setup M6 identity', (_name, runM5) => {
  it('accepts an M6 signed by the key it carries', async () => {
    const { m6, ltpk } = await buildM6((signature, raw) => ({
      [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw, [TlvTag.Signature]: signature,
    }));
    const credentials = await runM5(m6);
    expect(credentials.serverLTPK.equals(ltpk)).toBe(true);
    expect(credentials.serverId).toBe(accessoryId.toString());
  });

  it('rejects an M6 whose signature was altered', async () => {
    const { m6 } = await buildM6((signature, raw) => {
      const altered = Buffer.from(signature);
      altered[0] ^= 1;
      return { [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw, [TlvTag.Signature]: altered };
    });
    await expect(runM5(m6)).rejects.toThrow(/signature verification failed/);
  });

  it('rejects an M6 that carries a different key than the one that signed it', async () => {
    const other = accessoryKeys().raw;
    const { m6 } = await buildM6((signature) => ({
      [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: other, [TlvTag.Signature]: signature,
    }));
    await expect(runM5(m6)).rejects.toThrow(/signature verification failed/);
  });

  it('rejects an M6 without a signature', async () => {
    const { m6 } = await buildM6((_signature, raw) => ({ [TlvTag.Identifier]: accessoryId, [TlvTag.PublicKey]: raw }));
    await expect(runM5(m6)).rejects.toThrow(/missing a valid accessory public key or signature/);
  });
});
