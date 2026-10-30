/**
 * Legacy AirPlay PIN pair-setup for RAOP receivers that advertise the legacy pairing flags
 * (`sf`/`flags` 0x8 or 0x200): `POST /pair-pin-start` shows a PIN on the receiver, then three
 * binary-plist `POST /pair-setup-pin` steps run SRP-6a (RFC 5054 2048-bit group, SHA-1,
 * username = client id, password = PIN) and hand the receiver a new Ed25519 public key,
 * AES-128-GCM encrypted under the SRP session key. The returned 32-byte seed is the
 * `legacySeed` that `RaopStream.stream()` uses for legacy pair-verify.
 *
 * fast-srp-hap computes A and S, but it left-pads both to 256 bytes when hashing, while the
 * receiver uses minimal big-endian bytes; so K and M1 are computed here (see
 * `src/auth/__tests__/legacy-srp.test.ts` for the vectors that pin this).
 */

import { createHash, createCipheriv, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { SRP, SrpClient } from 'fast-srp-hap';
import { PersistentHttp } from '../util/http.js';
import { ed25519PrivateKeyFromSeed } from '../util/crypto.js';

/** Credentials from legacy PIN pairing. Store both; `seed` is a secret, like a password. */
export interface LegacyAirPlayCredentials {
  /** 16 upper-case hex characters; the SRP username the receiver recorded. */
  clientId: string;
  /** 32-byte Ed25519 seed; pass it to legacy RAOP or {@link LegacyAirPlayPlaybackSession}. */
  seed: Buffer;
}

/** RFC 5054 2048-bit group with SHA-1 (fast-srp-hap's own `params[2048]` uses SHA-256). */
const SRP_PARAMS = { ...SRP.params[2048], hash: 'sha1' };

/** Pairing headers without `X-Apple-HKP`, which would select HAP pairing instead. */
const HEADERS = { 'User-Agent': 'AirPlay/320.20', Connection: 'keep-alive', 'Content-Type': 'application/x-apple-binary-plist' };

function sha1(...parts: Buffer[]): Buffer {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Strip leading zero bytes: fast-srp-hap's 256-byte padded form to minimal big-endian. */
function unpad(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

/** H(N) xor H(g) for the 2048-bit group. */
const H_N_XOR_H_G = (() => {
  const hN = sha1(Buffer.from(SRP_PARAMS.N.toString(16), 'hex'));
  const hG = sha1(Buffer.from([2]));
  return Buffer.from(hN.map((byte, i) => byte ^ hG[i]!));
})();

/** AES-128-GCM key and IV from K; the receiver expects the IV's last byte incremented by one. */
function aesKeyIv(K: Buffer): { key: Buffer; iv: Buffer } {
  const key = createHash('sha512').update('Pair-Setup-AES-Key').update(K).digest().subarray(0, 16);
  const iv = createHash('sha512').update('Pair-Setup-AES-IV').update(K).digest().subarray(0, 16);
  iv[15] = (iv[15]! + 1) & 0xff;
  return { key, iv };
}

/**
 * Client side of one legacy PIN pairing. Call `start()` to make the receiver show a PIN,
 * then `finish(pin)`. The transport is closed when `finish()` settles.
 */
export class LegacyPairSetup {
  private http: Pick<PersistentHttp, 'post' | 'destroy'>;
  private readonly clientId = randomBytes(8).toString('hex').toUpperCase();
  private started = false;

  constructor(host: string, port: number, transport?: Pick<PersistentHttp, 'post' | 'destroy'>) {
    this.http = transport ?? new PersistentHttp(host, port, HEADERS);
  }

  /** POST /pair-pin-start, which makes the receiver display its PIN. */
  async start(): Promise<void> {
    await this.http.post('/pair-pin-start', Buffer.alloc(0));
    this.started = true;
  }

  /**
   * Run the three `/pair-setup-pin` steps with the PIN shown on the receiver.
   * @throws if called before `start()`, on a wrong PIN (the receiver rejects the proof),
   *   a malformed reply, or a receiver proof (M2) that does not match.
   */
  async finish(pin: string): Promise<LegacyAirPlayCredentials> {
    if (!this.started) throw new Error('LegacyPairSetup.finish() called before start()');
    const I = Buffer.from(this.clientId);
    let a: Buffer | undefined; let S: Buffer | undefined; let K: Buffer | undefined;
    try {
      const { pk: B, salt } = await this.postPlist({ method: 'pin', user: this.clientId });
      if (!Buffer.isBuffer(B) || B.length === 0 || !Buffer.isBuffer(salt) || salt.length === 0) {
        throw new Error('Legacy pair-setup: receiver reply lacks pk or salt');
      }

      a = randomBytes(32);
      const client = new SrpClient(SRP_PARAMS, salt, I, Buffer.from(pin), a);
      client.setB(B);
      const A = unpad(client.computeA());
      // fast-srp-hap keeps the premaster only in a private field (256-byte padded).
      S = (client as unknown as { _S: Buffer })._S;
      const s = unpad(S);
      K = Buffer.concat([sha1(s, Buffer.from([0, 0, 0, 0])), sha1(s, Buffer.from([0, 0, 0, 1]))]);
      const M1 = sha1(H_N_XOR_H_G, sha1(I), salt, A, unpad(B), K);

      let step2: Record<string, unknown>;
      try {
        step2 = await this.postPlist({ pk: A, proof: M1 });
      } catch (error) {
        const status = /^HTTP (\d+) from /.exec((error as Error).message)?.[1];
        if (status) throw new Error(`Legacy pair-setup failed: wrong PIN or receiver rejected the proof (HTTP ${status})`);
        throw error;
      }
      const M2 = sha1(A, M1, K);
      const proof = step2.proof;
      if (!Buffer.isBuffer(proof) || proof.length !== M2.length || !timingSafeEqual(proof, M2)) {
        throw new Error('Legacy pair-setup: receiver proof mismatch');
      }

      const seed = randomBytes(32);
      const publicKey = createPublicKey(ed25519PrivateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
      const { key, iv } = aesKeyIv(K);
      const cipher = createCipheriv('aes-128-gcm', key, iv);
      const epk = Buffer.concat([cipher.update(publicKey), cipher.final()]);
      key.fill(0);
      await this.postPlist({ epk, authTag: cipher.getAuthTag() });
      return { clientId: this.clientId, seed };
    } finally {
      a?.fill(0); S?.fill(0); K?.fill(0);
      this.http.destroy();
    }
  }

  /** POST one binary plist to /pair-setup-pin and parse the reply (an empty reply parses as {}). */
  private async postPlist(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.http.post('/pair-setup-pin', bplistCreator(body));
    if (reply.length === 0) return {};
    const parsed = parseBuffer(reply)[0];
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Legacy pair-setup: malformed receiver reply');
    return parsed as Record<string, unknown>;
  }
}
