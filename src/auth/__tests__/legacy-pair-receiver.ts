/**
 * Loopback legacy AirPlay PIN pair-setup receiver (`POST /pair-pin-start`, then three
 * binary-plist `POST /pair-setup-pin` steps) shared by the legacy pair-setup and RAOP stream
 * tests. B and S come from fast-srp-hap's `SrpServer` (2048-bit group, SHA-1); K, M1 and M2
 * use the Apple formulas computed here, independently of the client code, because `SrpServer`
 * pads S and so cannot check M1 when S has a leading zero byte. Step 3 is decrypted with
 * AES-128-GCM and the client's Ed25519 public key is recorded. Synthetic values only.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash, createDecipheriv, randomBytes } from 'node:crypto';
import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';
import { SRP, SrpServer } from 'fast-srp-hap';

/** RFC 5054 2048-bit group with SHA-1 (fast-srp-hap's own `params[2048]` is SHA-256). */
const params = { ...SRP.params[2048], hash: 'sha1' };

const sha1 = (...parts: Buffer[]): Buffer => {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const sha512 = (label: string, key: Buffer): Buffer => createHash('sha512').update(label).update(key).digest();

/** Strip leading zero bytes (fast-srp-hap's 256-byte padded form to minimal big-endian). */
export function unpad(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

/** H(N) xor H(g), hashing N and g as minimal big-endian bytes. */
const H_N_XOR_H_G = (() => {
  const hN = sha1(Buffer.from(params.N.toString(16), 'hex'));
  const hG = sha1(Buffer.from([2]));
  return Buffer.from(hN.map((byte, i) => byte ^ hG[i]!));
})();

export interface LegacyPairReceiverOptions {
  /** The PIN the receiver "displays"; defaults to '1234'. */
  pin?: string;
  /** Fixed SRP salt (default: 16 random bytes). */
  salt?: Buffer;
  /** Fixed SRP server private key b (default: 32 random bytes). */
  b?: Buffer;
  /** Send a corrupted M2 in step 2. */
  badProof?: boolean;
}

export interface LegacyPairReceiver {
  port: number;
  requests: { url: string; headers: IncomingHttpHeaders; body: Buffer }[];
  /** Protocol violations the receiver saw; a well-behaved client leaves this empty. */
  errors: string[];
  /** The step-2 plist the client sent (`pk` = A, `proof` = M1). */
  step2?: { pk: Buffer; proof: Buffer };
  /** Minimal big-endian premaster S the receiver derived in step 2. */
  premaster?: Buffer;
  /** The Ed25519 public key decrypted from step 3. */
  clientPublicKey?: Buffer;
  close(): Promise<void>;
}

/** Start a receiver on 127.0.0.1 with an ephemeral port. */
export async function legacyPairReceiver(options: LegacyPairReceiverOptions = {}): Promise<LegacyPairReceiver> {
  const pin = options.pin ?? '1234';
  const salt = options.salt ?? randomBytes(16);
  const b = options.b ?? randomBytes(32);
  let user: Buffer | undefined; let server: SrpServer | undefined; let B: Buffer | undefined; let K: Buffer | undefined;

  const reply = (res: ServerResponse, status: number, body: Buffer = Buffer.alloc(0)): void => {
    res.writeHead(status, { 'Content-Type': 'application/x-apple-binary-plist', 'Content-Length': body.length });
    res.end(body);
  };

  const http = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      result.requests.push({ url: req.url ?? '', headers: req.headers, body });
      const fail = (message: string): void => { result.errors.push(message); reply(res, 400); };
      const step = result.requests.length - 1;
      if (req.method !== 'POST') return fail(`unexpected method ${req.method}`);
      if (req.headers['x-apple-hkp'] !== undefined) return fail('X-Apple-HKP header sent');
      if (step === 0) {
        if (req.url !== '/pair-pin-start') return fail(`expected /pair-pin-start, got ${req.url}`);
        if (body.length !== 0) return fail('/pair-pin-start body not empty');
        return reply(res, 200);
      }
      if (req.url !== '/pair-setup-pin') return fail(`expected /pair-setup-pin, got ${req.url}`);
      if (req.headers['content-type'] !== 'application/x-apple-binary-plist') return fail('wrong content type');
      const plist = parseBuffer(body)[0] as Record<string, unknown>;

      if (step === 1) {
        if (plist.method !== 'pin') return fail('step 1 method is not pin');
        if (typeof plist.user !== 'string' || !/^[0-9A-F]{16}$/.test(plist.user)) return fail('step 1 user is not 16 upper-case hex');
        user = Buffer.from(plist.user);
        server = new SrpServer(params, SRP.computeVerifier(params, salt, user, Buffer.from(pin)), b);
        B = unpad(server.computeB());
        return reply(res, 200, bplistCreator({ pk: B, salt }));
      }
      if (step === 2) {
        const { pk: A, proof } = plist;
        if (!Buffer.isBuffer(A) || !Buffer.isBuffer(proof)) return fail('step 2 lacks pk or proof');
        if (A[0] === 0) return fail('step 2 A is zero-padded');
        result.step2 = { pk: A, proof };
        server!.setA(A);
        const S = unpad((server as unknown as { _S: Buffer })._S);
        result.premaster = Buffer.from(S);
        K = Buffer.concat([sha1(S, Buffer.from([0, 0, 0, 0])), sha1(S, Buffer.from([0, 0, 0, 1]))]);
        const expected = sha1(H_N_XOR_H_G, sha1(user!), salt, A, B!, K);
        if (!expected.equals(proof)) return reply(res, 470);
        const M2 = sha1(A, proof, K);
        if (options.badProof) M2[0]! ^= 0xff;
        return reply(res, 200, bplistCreator({ proof: M2 }));
      }
      if (step === 3) {
        const { epk, authTag } = plist;
        if (!Buffer.isBuffer(epk) || epk.length !== 32 || !Buffer.isBuffer(authTag) || authTag.length !== 16) return fail('step 3 lacks epk or authTag');
        const key = sha512('Pair-Setup-AES-Key', K!).subarray(0, 16);
        const iv = Buffer.from(sha512('Pair-Setup-AES-IV', K!).subarray(0, 16));
        iv[15] = (iv[15]! + 1) & 0xff;
        const decipher = createDecipheriv('aes-128-gcm', key, iv);
        decipher.setAuthTag(authTag);
        try { result.clientPublicKey = Buffer.concat([decipher.update(epk), decipher.final()]); } catch { return fail('step 3 authTag invalid'); }
        return reply(res, 200);
      }
      return fail(`unexpected request #${step + 1}`);
    });
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');

  const result: LegacyPairReceiver = {
    port: (http.address() as { port: number }).port,
    requests: [],
    errors: [],
    async close() { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); },
  };
  return result;
}
