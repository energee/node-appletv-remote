/**
 * ChaCha20-Poly1305 encryption session for the Companion protocol.
 * Differs from HAPSession:
 * - AAD = the 4-byte frame header (type + 3-byte length of plaintext)
 * - Encrypts whole messages (no 1024-byte chunking)
 * - Counter-based nonce, separate TX/RX counters
 */

import { encryptChaCha20, decryptChaCha20, generateNonce } from '../util/crypto.js';
import { FrameType } from './framing.js';

const AUTH_TAG_LENGTH = 16;

export class CompanionSession {
  private outCounter = 0n;
  private inCounter = 0n;

  constructor(
    private outKey: Buffer,
    private inKey: Buffer,
  ) {}

  /**
   * Encrypt a companion payload for sending.
   * Returns a complete frame: 4-byte header + ciphertext + 16-byte auth tag.
   */
  encrypt(frameType: FrameType, plaintext: Buffer): Buffer {
    const nonce = generateNonce(this.outCounter);
    this.outCounter++;

    // Build the frame header (used as AAD)
    const header = Buffer.alloc(4);
    header[0] = frameType;
    header[1] = (plaintext.length >> 16) & 0xff;
    header[2] = (plaintext.length >> 8) & 0xff;
    header[3] = plaintext.length & 0xff;

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
   * Input: raw data after the 4-byte frame header has been parsed.
   * The header bytes are needed as AAD.
   */
  decrypt(header: Buffer, encryptedPayload: Buffer): Buffer {
    const nonce = generateNonce(this.inCounter);
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
