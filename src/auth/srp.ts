import { randomBytes } from 'node:crypto';
import { SRP, SrpClient } from 'fast-srp-hap';

export class SRPClient {
  private client: SrpClient | undefined;
  private publicKey: Buffer | undefined;

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

  getPublicKey(): Buffer {
    if (!this.client || !this.publicKey) throw new Error('SRP not initialized');
    return this.publicKey;
  }

  setServerPublicKey(B: Buffer): void {
    if (!this.client) throw new Error('SRP not initialized');
    this.client.setB(B);
  }

  computeProof(): Buffer {
    if (!this.client) throw new Error('SRP not initialized');
    return this.client.computeM1();
  }

  verifyServerProof(M2: Buffer): void {
    if (!this.client) throw new Error('SRP not initialized');
    this.client.checkM2(M2);
  }

  getSharedSecret(): Buffer {
    if (!this.client) throw new Error('SRP not initialized');
    return this.client.computeK();
  }
}
