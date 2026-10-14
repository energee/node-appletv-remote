/**
 * Thin wrapper over fast-srp-hap's SRP-6a client, fixed to the HAP parameters
 * (3072-bit group, SHA-512, username "Pair-Setup") used by PairSetup.
 */

import { randomBytes } from 'node:crypto';
import { SRP, SrpClient } from 'fast-srp-hap';

/** SRP client state for one pair-setup attempt. Every method except `init` throws if `init` was not called first. */
export class SRPClient {
  private client: SrpClient | undefined;
  private publicKey: Buffer | undefined;

  /** Start SRP with the server's salt and the on-screen PIN as password; generates a random 32-byte private value a and computes A. */
  init(salt: Buffer, pin: string): void {
    const secret = randomBytes(32);
    this.client = new SrpClient(
      SRP.params.hap,
      salt,
      Buffer.from('Pair-Setup'),
      Buffer.from(pin),
      secret,
    );
    this.publicKey = this.client.computeA();
  }

  /** The client public key A. */
  getPublicKey(): Buffer {
    if (!this.client || !this.publicKey) throw new Error('SRP not initialized');
    return this.publicKey;
  }

  /** Supply the server public key B from M2. */
  setServerPublicKey(B: Buffer): void {
    if (!this.client) throw new Error('SRP not initialized');
    this.client.setB(B);
  }

  /** The client proof M1 sent in pair-setup M3. */
  computeProof(): Buffer {
    if (!this.client) throw new Error('SRP not initialized');
    return this.client.computeM1();
  }

  /** Check the server proof M2 from pair-setup M4; throws if it does not match (e.g. wrong PIN). */
  verifyServerProof(M2: Buffer): void {
    if (!this.client) throw new Error('SRP not initialized');
    this.client.checkM2(M2);
  }

  /** The SRP session key K, used as HKDF input for the M5/M6 keys. */
  getSharedSecret(): Buffer {
    if (!this.client) throw new Error('SRP not initialized');
    return this.client.computeK();
  }
}
