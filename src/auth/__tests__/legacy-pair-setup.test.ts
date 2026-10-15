/**
 * Legacy AirPlay PIN pair-setup (`LegacyPairSetup`) against a loopback node:http receiver:
 * request order and headers, the three `/pair-setup-pin` plists, the SRP proof checked with the
 * Apple formula, AES-128-GCM of the client Ed25519 public key, and the failure paths. The
 * leading-zero cases replay task-10 vectors (`legacy-srp.test.ts`) by queueing `randomBytes`
 * results through a `node:crypto` mock; the production class has no test-only parameter.
 */
import { createPublicKey } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { legacyPairReceiver, type LegacyPairReceiver, type LegacyPairReceiverOptions } from './legacy-pair-receiver.js';
import { ed25519PrivateKeyFromSeed } from '../../util/crypto.js';
import { PersistentHttp } from '../../util/http.js';

/** Buffers returned, in order, by the next `randomBytes` calls of matching size (then real randomness). */
const queuedRandom = vi.hoisted(() => [] as Buffer[]);
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = ((size: number, ...rest: unknown[]) =>
    queuedRandom[0]?.length === size && rest.length === 0
      ? queuedRandom.shift()!
      : (actual.randomBytes as (...args: unknown[]) => Buffer)(size, ...rest)) as typeof actual.randomBytes;
  return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

const { LegacyPairSetup } = await import('../legacy-pair-setup.js');

const receivers: LegacyPairReceiver[] = [];
afterEach(async () => { queuedRandom.length = 0; for (const r of receivers.splice(0)) await r.close(); });

async function receiver(options?: LegacyPairReceiverOptions): Promise<LegacyPairReceiver> {
  const r = await legacyPairReceiver(options); receivers.push(r); return r;
}

function ed25519Public(seed: Buffer): Buffer {
  return createPublicKey(ed25519PrivateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
}

describe('LegacyPairSetup', () => {
  it('pairs with the PIN: request order, headers, plists, proof, encrypted public key', async () => {
    const peer = await receiver({ pin: '4821' });
    const pairing = new LegacyPairSetup('127.0.0.1', peer.port);
    await pairing.start();
    const credentials = await pairing.finish('4821');

    expect(peer.errors).toEqual([]);
    expect(peer.requests.map(r => r.url)).toEqual(['/pair-pin-start', '/pair-setup-pin', '/pair-setup-pin', '/pair-setup-pin']);
    for (const request of peer.requests) {
      expect(request.headers['x-apple-hkp']).toBeUndefined();
      expect(request.headers['user-agent']).toBe('AirPlay/320.20');
      expect(request.headers['content-type']).toBe('application/x-apple-binary-plist');
    }
    expect(credentials.clientId).toMatch(/^[0-9A-F]{16}$/);
    expect(credentials.seed).toHaveLength(32);
    expect(peer.clientPublicKey).toEqual(ed25519Public(credentials.seed));
  });

  it('rejects a wrong PIN with a clear error and closes the transport', async () => {
    const peer = await receiver({ pin: '1234' });
    const http = new PersistentHttp('127.0.0.1', peer.port, { 'Content-Type': 'application/x-apple-binary-plist' });
    const destroy = vi.spyOn(http, 'destroy');
    const pairing = new LegacyPairSetup('127.0.0.1', peer.port, http);
    await pairing.start();
    await expect(pairing.finish('9999')).rejects.toThrow('Legacy pair-setup failed: wrong PIN or receiver rejected the proof (HTTP 470)');
    expect(peer.requests).toHaveLength(3);
    expect(destroy).toHaveBeenCalled();
  });

  it('rejects a receiver proof (M2) that does not match', async () => {
    const peer = await receiver({ badProof: true });
    const pairing = new LegacyPairSetup('127.0.0.1', peer.port);
    await pairing.start();
    await expect(pairing.finish('1234')).rejects.toThrow('Legacy pair-setup: receiver proof mismatch');
    expect(peer.requests).toHaveLength(3);
  });

  it('rejects finish() before start()', async () => {
    const post = vi.fn(async () => Buffer.alloc(0)); const destroy = vi.fn();
    const pairing = new LegacyPairSetup('127.0.0.1', 1, { post, destroy });
    await expect(pairing.finish('1234')).rejects.toThrow(/start\(\)/);
    expect(post).not.toHaveBeenCalled();
  });

  // Task-10 vectors (salt 10..1f, I = 366B4165DD64AD3A, P = 1234). fast-srp-hap's 256-byte padded
  // A or S would produce the wrong M1/K here; the receiver accepts only the Apple (unpadded) values.
  const vectorCases = {
    'leading-zero A': {
      a: 'da5c95248b08a86fea4f3f54e59de404a428b417cc39d897d6dc6c59d2695cdd',
      b: '5bbff309ebca78fbafdacf10237c6f637d5e5814f79228f6aa691bc6b733be8e',
      M1: '0e78b22a3d1c87792a749688b1c320258c9dfc47',
    },
    'leading-zero S': {
      a: 'a31281d28dbee8d51ac93a73d11fabba6baf3808f42a7b1f9702e10c1465e4b3',
      b: '07ebed1e4df91e37c69890a7a6a1886d4e7172aaf8cf7d8bdabb84a6f0166cee',
      M1: 'e27099a765b7c0172b4999d59658f6c36babd434',
    },
  };
  for (const [name, v] of Object.entries(vectorCases)) {
    it(`pairs on the ${name} vector (unpadded A and S in M1 and K)`, async () => {
      const peer = await receiver({ pin: '1234', salt: Buffer.from('101112131415161718191a1b1c1d1e1f', 'hex'), b: Buffer.from(v.b, 'hex') });
      // The constructor draws the client id (8 bytes); finish() draws SRP a (32), then the seed (32).
      queuedRandom.push(Buffer.from('366b4165dd64ad3a', 'hex'));
      const pairing = new LegacyPairSetup('127.0.0.1', peer.port);
      await pairing.start();
      queuedRandom.push(Buffer.from(v.a, 'hex'));
      const credentials = await pairing.finish('1234');
      expect(queuedRandom).toHaveLength(0);
      expect(peer.errors).toEqual([]);
      expect(credentials.clientId).toBe('366B4165DD64AD3A');
      expect(peer.step2!.proof.toString('hex')).toBe(v.M1);
      if (name === 'leading-zero A') expect(peer.step2!.pk).toHaveLength(255);
      else expect(peer.premaster).toHaveLength(255);
      expect(peer.clientPublicKey).toEqual(ed25519Public(credentials.seed));
    });
  }
});
