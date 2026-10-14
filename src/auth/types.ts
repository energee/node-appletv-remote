/** Shared types for HAP pairing (pair-setup / pair-verify). */

/**
 * Long-term pairing result shared by the AirPlay/MRP and Companion channels.
 * All keys are raw 32-byte Ed25519 values; `clientLTSK` is the private seed.
 */
export interface HAPCredentials {
  /** Our controller identifier, sent during pair-verify. */
  clientId: string;
  clientLTSK: Buffer;
  clientLTPK: Buffer;
  /** The Apple TV's long-term public key, used to check its pair-verify signature. */
  serverLTPK: Buffer;
  /** The Apple TV's pairing identifier from pair-setup M6. */
  serverId: string;
}
