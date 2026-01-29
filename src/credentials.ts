import type { HAPCredentials } from './auth/types.js';

export class Credentials implements HAPCredentials {
  clientId: string;
  clientLTSK: Buffer;
  clientLTPK: Buffer;
  serverLTPK: Buffer;
  serverId: string;

  constructor(creds: HAPCredentials) {
    this.clientId = creds.clientId;
    this.clientLTSK = creds.clientLTSK;
    this.clientLTPK = creds.clientLTPK;
    this.serverLTPK = creds.serverLTPK;
    this.serverId = creds.serverId;
  }

  serialize(): string {
    return JSON.stringify({
      clientId: this.clientId,
      clientLTSK: this.clientLTSK.toString('hex'),
      clientLTPK: this.clientLTPK.toString('hex'),
      serverLTPK: this.serverLTPK.toString('hex'),
      serverId: this.serverId,
    });
  }

  static deserialize(json: string): Credentials {
    const data = JSON.parse(json);
    return new Credentials({
      clientId: data.clientId,
      clientLTSK: Buffer.from(data.clientLTSK, 'hex'),
      clientLTPK: Buffer.from(data.clientLTPK, 'hex'),
      serverLTPK: Buffer.from(data.serverLTPK, 'hex'),
      serverId: data.serverId,
    });
  }
}
