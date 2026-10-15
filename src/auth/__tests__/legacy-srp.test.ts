/**
 * Compatibility check for legacy AirPlay PIN pairing (`/pair-setup-pin`) SRP:
 * SRP-6a, RFC 5054 2048-bit group, g = 2, SHA-1, I = client id, P = PIN, and
 * the Apple session key K = SHA1(S | 00000000) | SHA1(S | 00000001).
 *
 * It pins fast-srp-hap's `SrpClient`/`SrpServer` against vectors produced by
 * an independent SRP implementation, and pins the exact parameters and the
 * formula the legacy pair-setup code must use for K and M1.
 *
 * Finding 1: fast-srp-hap's `SRP.params[2048]` has the right N and g but
 * `hash: 'sha256'`, so used as-is k, x, B, u, K and M1 all differ from the
 * receiver. The legacy client must use `{ ...SRP.params[2048], hash: 'sha1' }`.
 *
 * Finding 2: with SHA-1, fast-srp-hap matches on the common path, but it left-pads A
 * (`getA` -> `toBuffer(256)`, reused verbatim in M1) and S (`client_getS` /
 * `server_getS` -> `toBuffer(256)`, hashed by `getK`) to the 256-byte modulus
 * length. The receiver (and the reference implementation) use minimal
 * big-endian bytes for A and S. So whenever A or S has a leading zero byte
 * (about 1 in 256 each), fast-srp-hap's `computeM1()` (A case) or
 * `computeK()`/`computeM1()` (S case) differ from what the receiver expects.
 * k = H(N | PAD(g)) and u = H(PAD(A) | PAD(B)) match in all cases. The legacy
 * client must therefore compute K and M1 itself (see `appleK`/`appleM1`
 * below) from the unpadded A, the received B, and the unpadded S.
 *
 * How the vectors were produced (reproducible): Python 3.14 + srptools 1.0.1
 * (pip), `SRPContext(I, P, prime=constants.PRIME_2048,
 * generator=constants.PRIME_2048_GEN, hash_func=hashlib.sha1)` with
 * `SRPContext.get_common_session_key` overridden to the Apple K above
 * (S = srptools `int_to_bytes(premaster)`, i.e. minimal big-endian). The
 * verifier came from `get_common_password_verifier(get_common_password_hash(salt))`;
 * `SRPServerSession(ctx, v, private=b)` and `SRPClientSession(ctx, private=a)`
 * each ran `process(...)`, agreed on K/M1/M2 and verified each other's proof.
 * - `common`: a = a0..bf, b = 40..5f (byte ranges).
 * - `leadingZeroA`: a = SHA256("legacy-srp-a-113"), b = SHA256("legacy-srp-b-0"),
 *   the first index i of SHA256("legacy-srp-a-<i>") giving a 255-byte A.
 * - `leadingZeroS`: a = SHA256("legacy-srp-a-0"), b = SHA256("legacy-srp-b-185"),
 *   the first index i of SHA256("legacy-srp-b-<i>") giving a 255-byte S.
 * All three use salt = 10..1f, I = '366B4165DD64AD3A', P = '1234'.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { SRP, SrpClient, SrpServer } from 'fast-srp-hap';

/** RFC 5054 2048-bit group with SHA-1 (fast-srp-hap's own `params[2048]` is SHA-256). */
const params = { ...SRP.params[2048], hash: 'sha1' };
const I = Buffer.from('366B4165DD64AD3A');
const P = Buffer.from('1234');
const salt = Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex');

/** H(N) xor H(g) for the RFC 5054 2048-bit group, g = 2 (from srptools). */
const H_N_XOR_H_G = Buffer.from('d18804efde5672636b7c613bafdad5df8e505f3c', 'hex');

interface Vector {
  a: string;
  b: string;
  /** Client public key, minimal big-endian bytes. */
  A: string;
  /** Server public key (256 bytes in every vector). */
  B: string;
  /** Premaster secret, minimal big-endian bytes (recorded for the edge vectors only). */
  S?: string;
  K: string;
  M1: string;
}

const vectors: Record<'common' | 'leadingZeroA' | 'leadingZeroS', Vector> = {
  common: {
    a: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf',
    b: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
    A: '7527af0242b3e5dfc8b86a1b41c7792581d1f959c44feee74a0986e3fed7cfc99e6132f886023227eb58ffc06d6479c26e13465ef465dd109d8ca9c55340ae7d5de0f17c4c370161aef405782454f616c2fbd02205e5ac4377458504f315824e6a03dfb8656b48011c4475314fe499f2473caf070bcbec6d7dcac25988ce5eb01272b7b153ab5447652d05659eea0828facef1f0809232b535402fdd9f49c8c958c073be60be0dd6f4726c572d76f16ec96cde6bbc09c7fcacc6b8c879ec8e21ac84a203b5206534e9a79ef1dfa578bdbdd2fb279f8374ee6835524257d129dab4099828c1a8a5e425bedea541b2476dbd4744f144a735951f6c2433e596bb71',
    B: '3a77bfbbf18269d9f223c73df610dc81fe42a0750730c12a630f4b671188ec9c70663cfb26eca04e43626971d8cb05bb7e82aa273afcedc940402ad3c3fcbc2941fe51d2cc033ab30071b34870053bfe2af809d2c22a663318f102f262a0a8ba7cc1e0f5ba1e71a5c721fe9be2fc36bad36ee20b8caefda4de918dadbadd656594daa799b74ced9f66006343889012164b7d242bf15733dda2db8a8149a857a4d8e306442a9387d33dc754027b5724b29d1e7a5eae9d9ad1f123ed39cdc1aed18d8a8fc67941a96c0cc533ed6e865c36b8262b5fe70842ed6a080becb99f627d167f60f702e8b89fafc38931c336621b9ddc7e1563f97e194cf4df1f7ecf0500',
    K: '5684b3bda76cdb0bd0900107e19156d94e914f91f667fef84e978b35abf423587fa98dc1aa8b2ff5',
    M1: 'd086366a3a16f5d88ee6b7dbe580a6754ae11c7a',
  },
  leadingZeroA: {
    a: 'da5c95248b08a86fea4f3f54e59de404a428b417cc39d897d6dc6c59d2695cdd',
    b: '5bbff309ebca78fbafdacf10237c6f637d5e5814f79228f6aa691bc6b733be8e',
    A: 'e548c9f77eba546e43eae4b89adc5bad70fe3ce9a686e3daaef07cada3f622251c965ec6061a01824fc572272b4f38755b1ece5f26135f7c60012d50ebfabf08fea2fd6326bec6e17320ec6853d95010b1b167f75d8a9cda24d51792c0f7e775635058a060f03c2951e49928a7e676e04d0b9b11e5baa7c7c1ad44635676228185b191cc3f49b2ebac7014f2940c30b9e7b6684169cf868fc57cdf7c5848d48c159d899d148a706fecdfca9db80746cc309c28575c0f80865319a1467092df5ea269bc80f51dbf06ce5c81d9182301e5b76a2b73c59907fd5c0c72c322c4b79f619288816d41d7e49c2a6d831f13d691558ad29129b3f310a27948fb4cd2e0',
    B: '37a2d2c217042207258687ed343ac7eb9b34a178c8e52ab3f7470c72f0ecf9a395277a96c83e0421ecce1a3d233736a9f7a421f0f59b75630ed4d19f285d96c8ac700bda1cb5566a27534a564f62ca9ef568bfbb6ee7b0384cb7a831b1f57a4e16b4fca92911b9d61d715d265e02b228076345e1f026469ce0bce4380248a7bdc21e055e245ba202be052a4e6de2a95a383e3be6a2fbed017d10e8d58be985c0881ee8091c72f9796bd930b5e984499dc6b1a1d018f4304a4e9f0b546425e5e3f2583f3131f00499aa88e0015976f4ca858007732181390f0722ce5d9c57edee5cbb13270146cd46e5edd19a405c99c0bbdd6158447694d84b82d1d2fae1b1b2',
    S: '1ad7b4de684c6183cf00607e04798b1d19be78a9bc2b66a355932309ff4c7420a9c6321dd1dc364fff73b7cb457573be1051365c9a3459a2878d12b060dc65a4e2adf2279c462543adfb11b4562028f6eaeb12b4e0421e05b858f1c9e45a5ee870976d8cc145012fef029a8d51739e243e003a4f763e5f27f6be43123dcd69e52a9911f5c70e1539f97effbd11c4ecfa640f5f24e6ddaf9724e0e55528e3af35c5fecc1898a40132a1472234f65df94d1c91d70cde489ffac9e0765f0c7366e4431e7e5ef00c3fb1c355e51b9886b17133c77ba87eb3af9bffda22d198ded2b2d3b66a44b8dc77a5fd64547ad93c84f0cf6e01099ebd551a026c8d170ffe56af',
    K: 'a7318e9e983444e8adb2fc41c56ee24aa43fb7e4c10ea249a2b8cdecb40d539884a4953996e6461a',
    M1: '0e78b22a3d1c87792a749688b1c320258c9dfc47',
  },
  leadingZeroS: {
    a: 'a31281d28dbee8d51ac93a73d11fabba6baf3808f42a7b1f9702e10c1465e4b3',
    b: '07ebed1e4df91e37c69890a7a6a1886d4e7172aaf8cf7d8bdabb84a6f0166cee',
    A: '44f5b1a8cc9df652cb17a7671471cef4962227ea46d0dfb68feb4d9c825c3b5642ce684de173799324a0293f97e0edc815205967925a5063b31023d67f7d1aa0178533be93c943d9bcc2387aa229cf6910413a814afac11390cf0c791c7cce61ec6fa433639bc15de07624ce70ed4f5e64ba03fbd95f624609a43dea6c927c3666ee133d3b51ce596fd60a8b092eed7fed6dace72ae659ef50d594a439b9d691d9f188784be25c049653c6e371f0459116e8a6d7bc49045573693bfa5fab758edb5718a6d2de760d990d404db17287eb7c5b0d8ec3ae87eb723bed5344fe689e1f25b205bef0b2240bd0385c76ce78a7af1d66bc880922bd50427464a144236d',
    B: '2e6b6a83e9e49bf820b232cbe83edc4e919070e65b923651406d468f0cb34f513d54c5537a436f5678445ece688a727eb5b985c6bb97ceb1b73eb5b4d8e8bb48abc1ae61063af0c28ca46147d1c4272c1d954c7ac38cbce39066dee5f7ddad201fd63a34955d557a125bb06b487ad61d24d052c6829799313f819c3f9879ed6259fe59a296ec611b45f2ba91d80f08077a632c172a9b3e40f506177436ddd5a280ca167143e579e16bcdbad8535d064801c42e88f96efb3bebd37de25db6e6195f2a70e60bf08a9e3bbf42feca310b421c3edf05ccacc0b45888f0ac73bce44dd8713c1f14bb584434fa09dbb3717b64f0f8498d0012acd97dc24a1123f029e2',
    S: '0f6178edabe7bcbfb92a4a3a4aa2fbf29af3aab54183aa607479d7d11936c5d8c0e9e1401fd0a330e38356178dbdd7012a475d3b77ed22e819957d4561275d770394d2729a4589f84fa7ff506fbb4ce8be6f7e795a5f4fd41fa9eb90fb33e542d2e351d3ee3ba1fc467e6f95052360c1a45e89392ccf1839608ee20b3a32e3c2e1e38fd662151f9b679b7afd81d36686eceebdbdbdc61133db48992dbf7b04a6ccea2c295e07f94be7db1a4f992b4926bc12ce8fe641a630a47f8f64203997ca3cb1a6b6134bb368e5939255a1f6cfd358d0901792c0739b6531ed2a4ca3d566eb639fb95c573584152e4014bcb51f45cc023b9712c3e30f97a8d6ff166792',
    K: 'e556bfd2bed3807417dabe828dc0c1862162ff1720bf95116819816dbbc00d79b05d11f02a9db4e9',
    M1: 'e27099a765b7c0172b4999d59658f6c36babd434',
  },
};

const hex = (s: string): Buffer => Buffer.from(s, 'hex');
const sha1 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Strip leading zero bytes: fast-srp-hap's 256-byte padded form -> minimal big-endian. */
function unpad(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

/** Apple legacy session key K = SHA1(S | 00000000) | SHA1(S | 00000001), S unpadded. */
function appleK(S: Buffer): Buffer {
  const s = unpad(S);
  return Buffer.concat([sha1(s, Buffer.from([0, 0, 0, 0])), sha1(s, Buffer.from([0, 0, 0, 1]))]);
}

/** Apple legacy proof M1 = H(H(N) xor H(g) | H(I) | s | A | B | K), A and B unpadded. */
function appleM1(A: Buffer, B: Buffer, K: Buffer): Buffer {
  return sha1(H_N_XOR_H_G, sha1(I), salt, unpad(A), unpad(B), K);
}

/** fast-srp-hap keeps S (256-byte padded) only in a private field. */
function premasterOf(client: SrpClient): Buffer {
  return (client as unknown as { _S: Buffer })._S;
}

function makeClient(v: Vector): SrpClient {
  const client = new SrpClient(params, salt, I, P, hex(v.a));
  client.setB(hex(v.B));
  return client;
}

function makeServer(v: Vector): SrpServer {
  return new SrpServer(params, salt, I, P, hex(v.b));
}

describe('legacy SRP (2048-bit, SHA-1) vs independent srptools vectors', () => {
  it("fast-srp-hap's SRP.params[2048] is SHA-256, so it must be overridden to SHA-1", () => {
    expect(SRP.params[2048].hash).toBe('sha256');
    const v = vectors.common;
    const asShipped = new SrpClient(SRP.params[2048], salt, I, P, hex(v.a));
    asShipped.setB(hex(v.B));
    expect(asShipped.computeK()).not.toEqual(hex(v.K));
  });

  it('H(N) xor H(g) constant matches the 2048-bit group', () => {
    const hN = sha1(hex(params.N.toString(16)));
    const hG = sha1(Buffer.from([2]));
    expect(Buffer.from(hN.map((b, i) => b ^ hG[i]!))).toEqual(H_N_XOR_H_G);
  });

  describe.each(Object.entries(vectors))('%s vector', (_name, v) => {
    it('SrpClient A equals the vector A (numerically; fast-srp-hap pads to 256 bytes)', () => {
      const A = new SrpClient(params, salt, I, P, hex(v.a)).computeA();
      expect(A).toHaveLength(256);
      expect(unpad(A)).toEqual(hex(v.A));
    });

    it('SrpServer (verifier from SRP.computeVerifier) produces the vector B', () => {
      const verifier = SRP.computeVerifier(params, salt, I, P);
      expect(new SrpServer(params, verifier, hex(v.b)).computeB()).toEqual(hex(v.B));
    });

    it('the inline Apple K and M1 from SrpClient state reproduce the vector', () => {
      const client = makeClient(v);
      if (v.S) expect(unpad(premasterOf(client))).toEqual(hex(v.S));
      const K = appleK(premasterOf(client));
      expect(K).toEqual(hex(v.K));
      expect(appleM1(client.computeA(), hex(v.B), K)).toEqual(hex(v.M1));
    });
  });

  it('common case: fast-srp-hap computeA/computeK/computeM1 match the vector as-is', () => {
    const v = vectors.common;
    const client = makeClient(v);
    expect(client.computeA()).toEqual(hex(v.A));
    expect(client.computeK()).toEqual(hex(v.K));
    expect(client.computeM1()).toEqual(hex(v.M1));
  });

  it('leading-zero A: computeK matches but computeM1 differs (M1 hashes the 256-byte padded A)', () => {
    const v = vectors.leadingZeroA;
    const client = makeClient(v);
    expect(client.computeK()).toEqual(hex(v.K));
    expect(client.computeM1()).not.toEqual(hex(v.M1));
  });

  it('leading-zero S: computeK and computeM1 differ (K hashes the 256-byte padded S)', () => {
    const v = vectors.leadingZeroS;
    const client = makeClient(v);
    expect(client.computeK()).not.toEqual(hex(v.K));
    expect(client.computeM1()).not.toEqual(hex(v.M1));
  });

  describe('SrpServer verifying the Apple M1 (sent with an unpadded A)', () => {
    it('accepts it and derives the same K when S has no leading zero (common, leadingZeroA)', () => {
      for (const v of [vectors.common, vectors.leadingZeroA]) {
        const server = makeServer(v);
        server.setA(hex(v.A));
        expect(() => server.checkM1(hex(v.M1))).not.toThrow();
        expect(server.computeK()).toEqual(hex(v.K));
      }
    });

    it('rejects it when S has a leading zero (server K hashes the padded S)', () => {
      const v = vectors.leadingZeroS;
      const server = makeServer(v);
      server.setA(hex(v.A));
      expect(() => server.checkM1(hex(v.M1))).toThrow();
      expect(server.computeK()).not.toEqual(hex(v.K));
    });
  });
});
