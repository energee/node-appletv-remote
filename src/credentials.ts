/**
 * Persistable pairing credentials: AirPlay HAP keys plus optional Companion
 * keys, serialized as JSON with hex-encoded key buffers.
 */

import type { HAPCredentials } from './auth/types.js';

/** Parse a string produced by Credentials.serialize(); alias for Credentials.deserialize. */
export function parseCredentials(text: string): Credentials {
  return Credentials.deserialize(text);
}

/** AirPlay pair-setup credentials, optionally bundled with the separately paired Companion credentials. */
export class Credentials implements HAPCredentials {
  clientId: string;
  clientLTSK: Buffer;
  clientLTPK: Buffer;
  serverLTPK: Buffer;
  serverId: string;
  /** Credentials from Companion pairing; stored under the `companion` key when serialized. */
  companionCredentials?: HAPCredentials;

  constructor(creds: HAPCredentials, companionCredentials?: HAPCredentials) {
    this.clientId = creds.clientId;
    this.clientLTSK = creds.clientLTSK;
    this.clientLTPK = creds.clientLTPK;
    this.serverLTPK = creds.serverLTPK;
    this.serverId = creds.serverId;
    this.companionCredentials = companionCredentials;
  }

  /** Encode as JSON with keys hex-encoded; the inverse of deserialize(). */
  serialize(): string {
    const obj: Record<string, unknown> = {
      clientId: this.clientId,
      clientLTSK: this.clientLTSK.toString('hex'),
      clientLTPK: this.clientLTPK.toString('hex'),
      serverLTPK: this.serverLTPK.toString('hex'),
      serverId: this.serverId,
    };
    if (this.companionCredentials) {
      obj.companion = {
        clientId: this.companionCredentials.clientId,
        clientLTSK: this.companionCredentials.clientLTSK.toString('hex'),
        clientLTPK: this.companionCredentials.clientLTPK.toString('hex'),
        serverLTPK: this.companionCredentials.serverLTPK.toString('hex'),
        serverId: this.companionCredentials.serverId,
      };
    }
    return JSON.stringify(obj);
  }

  /**
   * Decode JSON from serialize(). Fields are not validated.
   * @throws {SyntaxError} If `json` is not valid JSON.
   */
  static deserialize(json: string): Credentials {
    const data = JSON.parse(json);
    let companionCreds: HAPCredentials | undefined;
    if (data.companion) {
      companionCreds = {
        clientId: data.companion.clientId,
        clientLTSK: Buffer.from(data.companion.clientLTSK, 'hex'),
        clientLTPK: Buffer.from(data.companion.clientLTPK, 'hex'),
        serverLTPK: Buffer.from(data.companion.serverLTPK, 'hex'),
        serverId: data.companion.serverId,
      };
    }
    return new Credentials(
      {
        clientId: data.clientId,
        clientLTSK: Buffer.from(data.clientLTSK, 'hex'),
        clientLTPK: Buffer.from(data.clientLTPK, 'hex'),
        serverLTPK: Buffer.from(data.serverLTPK, 'hex'),
        serverId: data.serverId,
      },
      companionCreds,
    );
  }
}
