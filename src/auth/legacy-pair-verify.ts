/** Legacy AirPlay pair-verify using the seed produced by {@link LegacyPairSetup}. */
import { createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, sign, type KeyObject } from 'node:crypto';
import { X25519_PKCS8_PREFIX, ed25519PrivateKeyFromSeed, x25519PublicKeyFromRaw } from '../util/crypto.js';

export interface LegacyPairVerifyTransport {
  post(path: '/pair-verify', body: Buffer): Promise<Buffer>;
}

/**
 * Prove possession of a legacy pairing seed on an existing receiver transport.
 * The caller retains ownership of `seed`; this function neither mutates nor retains it.
 */
export async function verifyLegacyPairing(transport: LegacyPairVerifyTransport, seed: Buffer): Promise<void> {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('Legacy AirPlay seed must contain 32 bytes');
  const curveDer = Buffer.concat([X25519_PKCS8_PREFIX, seed]);
  let curveKey: KeyObject;
  let signingKey: KeyObject;
  try {
    curveKey = createPrivateKey({ format: 'der', type: 'pkcs8', key: curveDer });
    signingKey = ed25519PrivateKeyFromSeed(seed);
  } finally { curveDer.fill(0); }
  const curvePublic = createPublicKey(curveKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const signingPublic = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const response = await transport.post('/pair-verify', Buffer.concat([Buffer.from([1, 0, 0, 0]), curvePublic, signingPublic]));
  if (response.length !== 96) throw new Error('Invalid legacy pair-verify response: expected 96 bytes');
  const receiverPublic = response.subarray(0, 32);
  const shared = diffieHellman({ privateKey: curveKey, publicKey: x25519PublicKeyFromRaw(receiverPublic) });
  let key: Buffer | undefined;
  let iv: Buffer | undefined;
  let signed: Buffer | undefined;
  try {
    key = createHash('sha512').update('Pair-Verify-AES-Key').update(shared).digest();
    iv = createHash('sha512').update('Pair-Verify-AES-IV').update(shared).digest();
    const cipher = createCipheriv('aes-128-ctr', key.subarray(0, 16), iv.subarray(0, 16));
    cipher.update(response.subarray(32));
    signed = sign(null, Buffer.concat([curvePublic, receiverPublic]), signingKey);
    const signature = cipher.update(signed);
    cipher.final();
    await transport.post('/pair-verify', Buffer.concat([Buffer.alloc(4), signature]));
  } finally { shared.fill(0); key?.fill(0); iv?.fill(0); signed?.fill(0); }
}
