/**
 * Session-only AirPlay transient pairing. Unlike normal HAP pair-setup this exchange stops at
 * SRP M4: it creates neither a controller identity nor stored credentials. The SRP shared secret
 * is used directly to derive the control and event-channel keys for this one RTSP connection.
 */
import { TlvTag, tlvDecode, tlvEncode, type TlvData } from '../util/tlv.js';
import { hkdfSha512 } from '../util/crypto.js';
import { SRPClient } from './srp.js';
import type { RtspClient } from '../raop/stream.js';

const PIN = '3939';
const SRP_SALT_LENGTH = 16;
const SRP_PUBLIC_KEY_LENGTH = 384;
const SRP_PROOF_LENGTH = 64;
/** One transient session's directional control keys and SRP shared secret for event setup. */
export interface TransientPairKeys {
  outputKey: Buffer;
  inputKey: Buffer;
  sharedSecret: Buffer;
}
export class TransientPair {
  private readonly srp = new SRPClient();

  constructor(private readonly client: RtspClient, private readonly signal?: AbortSignal) {}

  /** Transient pair-setup M1: normal pair-setup method plus the transient flag. */
  buildM1(): Buffer {
    return tlvEncode({
      [TlvTag.Method]: Buffer.from([0]),
      [TlvTag.SeqNo]: Buffer.from([1]),
      [TlvTag.Flags]: Buffer.from([0x10]),
    });
  }

  /** SRP pair-setup M3. */
  buildM3(publicKey: Buffer, proof: Buffer): Buffer {
    return tlvEncode({
      [TlvTag.SeqNo]: Buffer.from([3]),
      [TlvTag.PublicKey]: publicKey,
      [TlvTag.Proof]: proof,
    });
  }

  /** Complete transient pair-pin-start and pair-setup M1-M4, retaining no identity or credentials. */
  async verify(): Promise<TransientPairKeys> {
    let m1: Buffer | undefined;
    let m3: Buffer | undefined;
    let salt: Buffer | undefined;
    let serverPublicKey: Buffer | undefined;
    let clientPublicKey: Buffer | undefined;
    let proof: Buffer | undefined;
    let serverProof: Buffer | undefined;
    let sharedSecret: Buffer | undefined;
    let outputKey: Buffer | undefined;
    let inputKey: Buffer | undefined;
    try {
      await this.post('/pair-pin-start', Buffer.alloc(0));
      m1 = this.buildM1();
      const m2 = this.decode(await this.post('/pair-setup', m1), 2, 'M2');
      salt = m2[TlvTag.Salt];
      serverPublicKey = m2[TlvTag.PublicKey];
      if (!salt || salt.length !== SRP_SALT_LENGTH || !serverPublicKey || serverPublicKey.length !== SRP_PUBLIC_KEY_LENGTH) {
        throw new Error('Invalid transient pair-setup M2 SRP material');
      }

      this.srp.init(salt, PIN);
      this.srp.setServerPublicKey(serverPublicKey);
      clientPublicKey = this.srp.getPublicKey();
      proof = this.srp.computeProof();
      if (clientPublicKey.length !== SRP_PUBLIC_KEY_LENGTH || proof.length !== SRP_PROOF_LENGTH) throw new Error('Invalid transient SRP proof');
      m3 = this.buildM3(clientPublicKey, proof);
      const m4 = this.decode(await this.post('/pair-setup', m3), 4, 'M4');
      serverProof = m4[TlvTag.Proof];
      if (!serverProof || serverProof.length !== SRP_PROOF_LENGTH) throw new Error('Invalid transient pair-setup M4 proof');
      this.srp.verifyServerProof(serverProof);

      sharedSecret = this.srp.getSharedSecret();
      [outputKey, inputKey] = await Promise.all([
        hkdfSha512(sharedSecret, 'Control-Salt', 'Control-Write-Encryption-Key', 32),
        hkdfSha512(sharedSecret, 'Control-Salt', 'Control-Read-Encryption-Key', 32),
      ]);
      const keys = { outputKey, inputKey, sharedSecret };
      outputKey = undefined; inputKey = undefined; sharedSecret = undefined;
      return keys;
    } finally {
      m1?.fill(0); m3?.fill(0); salt?.fill(0); serverPublicKey?.fill(0); clientPublicKey?.fill(0);
      proof?.fill(0); serverProof?.fill(0); sharedSecret?.fill(0); outputKey?.fill(0); inputKey?.fill(0);
      this.srp.destroy();
    }
  }

  private async post(path: '/pair-pin-start' | '/pair-setup', body: Buffer): Promise<Buffer> {
    return (await this.client.request('POST', {
      'X-Apple-HKP': '4', 'Content-Type': 'application/octet-stream',
    }, body, this.signal, 5000, path)).body;
  }

  private decode(body: Buffer, sequence: number, message: string): TlvData {
    try {
      const tlv = tlvDecode(body);
      const error = tlv[TlvTag.Error];
      if (error) throw new Error(`Transient pair-setup ${message} error: ${error.length === 1 ? error[0] : 'invalid'}`);
      const state = tlv[TlvTag.SeqNo];
      if (!state || state.length !== 1 || state[0] !== sequence) throw new Error(`Unexpected transient pair-setup ${message} state`);
      return tlv;
    } finally {
      body.fill(0);
    }
  }
}
