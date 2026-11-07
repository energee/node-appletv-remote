/**
 * Decrypts and checks the accessory's pair-setup M6 for the AirPlay, MRP and Companion flows.
 * It works on TLV data only, so those flows share it without depending on each other's transport.
 */

import { verify } from 'node:crypto';
import { TlvTag, tlvDecode, type TlvData } from '../util/tlv.js';
import { hkdfSha512, decryptChaCha20, ed25519PublicKeyFromRaw } from '../util/crypto.js';

/**
 * Decrypt a pair-setup M6 and verify the accessory signature inside it.
 * The accessory signs AccessoryX || AccessoryPairingID || AccessoryLTPK with its long-term key
 * (HAP pair-setup M6), where AccessoryX is derived from the SRP session key.
 *
 * A passing check proves only that the sender holds the private key for the LTPK it sent, and
 * that the message is bound to this SRP session. It does NOT prove the peer is a genuine Apple TV:
 * there is no trust anchor, so anyone who completes SRP with the PIN can generate a key and pass.
 * @param sessionKey the SRP shared secret, which AccessoryX is derived from
 * @param encryptionKey the Pair-Setup-Encrypt key derived from `sessionKey`
 * @param m6 the decoded M6 TLV
 * @param label prefix for error messages, naming the protocol (e.g. `Companion PS M6`)
 * @returns the accessory's identifier and long-term public key
 * @throws if EncryptedData is missing or does not decrypt, if the Identifier is missing or empty,
 * if the PublicKey is not 32 bytes or the Signature not 64, or if the signature does not verify
 */
export async function verifyPairSetupM6(
  sessionKey: Buffer,
  encryptionKey: Buffer,
  m6: TlvData,
  label: string,
): Promise<{ serverId: string; serverLTPK: Buffer }> {
  const encrypted = m6[TlvTag.EncryptedData];
  if (!encrypted) {
    const error = m6[TlvTag.Error];
    throw new Error(`${label} missing EncryptedData (error=${error ? error[0] : 'none'})`);
  }

  // The 12-byte nonce is 4 zero bytes + "PS-Msg06"; the last 16 bytes are the Poly1305 auth tag
  const nonce = Buffer.alloc(12, 0);
  nonce.write('PS-Msg06', 4);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const decrypted = decryptChaCha20(encryptionKey, nonce, ciphertext, tag, Buffer.alloc(0));

  const serverInfo = tlvDecode(decrypted);
  const serverId = serverInfo[TlvTag.Identifier];
  const serverLTPK = serverInfo[TlvTag.PublicKey];
  const serverSignature = serverInfo[TlvTag.Signature];
  if (!serverId?.length) throw new Error(`${label} missing Identifier`);
  if (serverLTPK?.length !== 32) throw new Error(`${label} missing a 32-byte PublicKey`);
  if (serverSignature?.length !== 64) throw new Error(`${label} missing a 64-byte Signature`);

  const accessoryX = await hkdfSha512(
    sessionKey,
    'Pair-Setup-Accessory-Sign-Salt',
    'Pair-Setup-Accessory-Sign-Info',
    32,
  );
  const signed = Buffer.concat([accessoryX, serverId, serverLTPK]);
  if (!verify(null, signed, ed25519PublicKeyFromRaw(serverLTPK), serverSignature)) {
    throw new Error(`${label} accessory signature verification failed; start pairing again, and if it keeps failing report the Apple TV model and tvOS version`);
  }
  return { serverId: serverId.toString('utf-8'), serverLTPK };
}
