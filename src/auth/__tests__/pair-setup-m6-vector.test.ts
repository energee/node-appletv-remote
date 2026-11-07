/**
 * Known-answer vector for pair-setup M6, computed outside this codebase (#135).
 *
 * Source: a Python standard-library implementation that shares no code with this project.
 * HKDF, ChaCha20-Poly1305 and Ed25519 were written from RFC 5869, 8439 and 8032 and passed those
 * RFCs' published vectors. RFC 5869 publishes no SHA-512 vector, so its SHA-256 and SHA-1 cases
 * covered the construction, and the openssl CLI reproduced every derived value here (both HKDF
 * outputs, the public key, the signature, the ciphertext and the tag).
 *
 * THIS IS NOT A HARDWARE CAPTURE. K is a made-up constant, not the result of SRP with an Apple TV.
 *
 * What it proves: sendM5 agrees with a second implementation of the HAP specification on the
 * Encrypt and Accessory-Sign HKDF labels, the PS-Msg06 nonce, the signed-data layout and the M6
 * TLV tags. Nothing here is derived by the code under test, so unlike the fake M6 in
 * pair-setup-m6.test.ts, a wrong constant cannot be repeated on both sides and stay green.
 *
 * What it does not prove: that K, or anything derived from it, matches what real hardware computes;
 * that SRP is correct (K is written straight into sessionKey); that the M5 this client sends is
 * correct (its Controller-Sign labels and PS-Msg05 nonce are not checked); or that tvOS behaves as
 * the specification says. Both sides also read the same specification, so a shared misreading of it
 * would pass. A captured M6 is still wanted, and #135 stays open for it.
 *
 * The generator is not in this repo. To recompute the vector with any implementation:
 *   seed  = 28554486a912c8bbfe5497f64ea8177fc18e972f972600bdc619b205644c8666 (accessory Ed25519 seed)
 *   key   = HKDF-SHA512(K, salt 'Pair-Setup-Encrypt-Salt', info 'Pair-Setup-Encrypt-Info', 32)
 *   X     = HKDF-SHA512(K, salt 'Pair-Setup-Accessory-Sign-Salt', info 'Pair-Setup-Accessory-Sign-Info', 32)
 *   sig   = Ed25519(seed, X || IDENTIFIER || LTPK)
 *   inner = TLV8(Identifier 0x01, PublicKey 0x03, Signature 0x0a)
 *   M6    = TLV8(SeqNo 0x06 = 6, EncryptedData 0x05 = ChaCha20-Poly1305(key, 00000000 || 'PS-Msg06', no AAD, inner) || tag)
 */

import { describe, it, expect } from 'vitest';
import { PairSetup } from '../pair-setup.js';
import { CompanionPairSetup } from '../../companion/pair-setup.js';

const K = Buffer.from(
  '81641a3f88012a4e6162ddc8be2f565a64cf5fad9dd6fd5fbe3b56ebf96f1ab4'
  + 'dfa3700b2eac01102ba6ad7021baf96d71833d1107f942f4b7f9f9d3f20c28af',
  'hex',
);

const IDENTIFIER = '7F3C9A12-5D2E-4B6A-8C41-0E6D2F9B1A37';
const LTPK_HEX = '117cb46662cd76869bacf7950309d6fe580ab49d64a64a3f57d1aa0e826c6496';

const M6 = Buffer.from(
  '060106' // SeqNo (0x06) = 6
  + '059a' // EncryptedData (0x05), 154 bytes, so no TLV8 fragmentation: 138 ciphertext + 16 tag
  + '178a14c8d90fb864a2a3aab12d728047d6453558e1859f89b6fdee74d501b747a6c10be3184e274a9e703c32c2617d55'
  + '0ef57c6dca4fb3f1626b48786b6057790bf11bc84e071f4204f4f063991a4741b751bc07b8d6b97291bf8609c9cdbaa8'
  + '412b4806176f8fcf174284438d0e4b8d1aa00f520ea1ddcb822c6a9768b406dd6c9b907a9f117158f1c5e541efd5f4e7'
  + '701921eda43258c21aac',
  'hex',
);

/** First ciphertext byte: past the 3-byte SeqNo item and the 2-byte EncryptedData header. */
const CIPHERTEXT_OFFSET = 5;

/** Run M5 on each pair-setup flavour with the vector's K, answering with the given M6. */
const flavours: Array<[string, (m6: Buffer) => Promise<{ serverLTPK: Buffer; serverId: string }>]> = [
  ['AirPlay', (m6) => {
    const pair = new PairSetup('127.0.0.1', 7000, { post: () => Promise.resolve(m6), destroy: () => {} });
    (pair as unknown as { sessionKey: Buffer }).sessionKey = K;
    return pair.sendM5();
  }],
  ['Companion', (m6) => {
    const pair = new CompanionPairSetup('127.0.0.1', 49153);
    const internals = pair as unknown as {
      sessionKey: Buffer;
      sendPairingData(data: Buffer): void;
      receivePairingData(): Promise<Buffer>;
    };
    internals.sessionKey = K;
    internals.sendPairingData = () => {};
    internals.receivePairingData = () => Promise.resolve(m6);
    return pair.sendM5();
  }],
];

describe.each(flavours)('%s pair-setup M6 known-answer vector', (_name, runM5) => {
  it('returns the identity from an M6 computed outside this codebase', async () => {
    const credentials = await runM5(M6);
    expect(credentials.serverId).toBe(IDENTIFIER);
    expect(credentials.serverLTPK.toString('hex')).toBe(LTPK_HEX);
  });

  it('rejects the vector with one ciphertext bit flipped', async () => {
    const tampered = Buffer.from(M6);
    tampered[CIPHERTEXT_OFFSET] ^= 0x01;
    // Node reports the failed Poly1305 check as "unable to authenticate data"; the noble fallback as "invalid tag".
    await expect(runM5(tampered)).rejects.toThrow(/unable to authenticate data|invalid tag/);
  });
});
