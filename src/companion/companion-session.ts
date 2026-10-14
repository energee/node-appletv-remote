/**
 * ChaCha20-Poly1305 encryption session for the Companion protocol, created by
 * CompanionConnection after pair-verify. Differs from HAPSession (src/util/hap-session.ts):
 * - AAD = the 4-byte frame header (type + 3-byte ciphertext-and-tag length)
 * - Encrypts whole messages (no 1024-byte chunking)
 * - Counter-based nonce, separate TX/RX counters
 */

import { encryptChaCha20, decryptChaCha20 } from '../util/crypto.js';
import type { FrameType } from './framing.js';

/** Poly1305 authentication tag length, counted in the frame header length. */
const AUTH_TAG_LENGTH = 16;

/** Build the 12-byte nonce for a message counter. */
function companionNonce(counter: bigint): Buffer {
  // Companion counts from byte zero of a 12-byte little-endian nonce.
  // HAP/AirPlay instead put four zero bytes before their 8-byte counter.
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(counter, 0);
  return nonce;
}

/**
 * Encrypts outgoing and decrypts incoming Companion frames with independent keys and
 * counters. Each call consumes one nonce, so frames must be processed in wire order.
 */
export class CompanionSession {
  private outCounter = 0n;
  private inCounter = 0n;

  /**
   * @param outKey client-to-server key (HKDF "ClientEncrypt-main")
   * @param inKey server-to-client key (HKDF "ServerEncrypt-main")
   */
  constructor(
    private outKey: Buffer,
    private inKey: Buffer,
  ) {}

  /**
   * Encrypt a companion payload for sending.
   * Returns a complete frame: 4-byte header + ciphertext + 16-byte auth tag.
   * @throws {RangeError} if the payload plus tag exceeds the 3-byte length field
   */
  encrypt(frameType: FrameType, plaintext: Buffer): Buffer {
    // Build the frame header (used as AAD) before advancing the counter, so an
    // oversized payload throws without desynchronizing the nonce with the peer.
    const header = Buffer.alloc(4);
    header[0] = frameType;
    if (plaintext.length + AUTH_TAG_LENGTH > 0xffffff) {
      throw new RangeError('Companion payload too large for a 3-byte frame length');
    }
    header.writeUIntBE(plaintext.length + AUTH_TAG_LENGTH, 1, 3);

    const nonce = companionNonce(this.outCounter);
    this.outCounter++;

    const { ciphertext, tag } = encryptChaCha20(
      this.outKey,
      nonce,
      plaintext,
      header,
    );

    return Buffer.concat([header, ciphertext, tag]);
  }

  /**
   * Decrypt a companion frame payload.
   * @param header the frame's 4-byte header, used as AAD
   * @param encryptedPayload the bytes after the header: ciphertext + 16-byte auth tag
   * @throws if authentication fails (the inbound counter has still advanced)
   */
  decrypt(header: Buffer, encryptedPayload: Buffer): Buffer {
    const nonce = companionNonce(this.inCounter);
    this.inCounter++;

    const ciphertext = encryptedPayload.subarray(0, encryptedPayload.length - AUTH_TAG_LENGTH);
    const tag = encryptedPayload.subarray(encryptedPayload.length - AUTH_TAG_LENGTH);

    return decryptChaCha20(
      this.inKey,
      nonce,
      ciphertext,
      tag,
      header,
    );
  }
}
