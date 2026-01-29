export interface HAPCredentials {
  clientId: string;
  clientLTSK: Buffer;
  clientLTPK: Buffer;
  serverLTPK: Buffer;
  serverId: string;
}
