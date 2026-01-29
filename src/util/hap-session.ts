import { encryptChaCha20, decryptChaCha20, generateNonce } from './crypto.js';

const FRAME_LENGTH = 1024;
const AUTH_TAG_LENGTH = 16;

export class HAPSession {
  private outCounter = 0n;
  private inCounter = 0n;

  constructor(
    private outKey: Buffer,
    private inKey: Buffer,
  ) {}

  encrypt(data: Buffer): Buffer {
    const frames: Buffer[] = [];
    let offset = 0;

    while (offset < data.length) {
      const chunkSize = Math.min(FRAME_LENGTH, data.length - offset);
      const chunk = data.subarray(offset, offset + chunkSize);
      const lengthBytes = Buffer.alloc(2);
      lengthBytes.writeUInt16LE(chunkSize);

      const nonce = generateNonce(this.outCounter);
      this.outCounter++;

      const { ciphertext, tag } = encryptChaCha20(
        this.outKey,
        nonce,
        chunk,
        lengthBytes,
      );

      frames.push(lengthBytes, ciphertext, tag);
      offset += chunkSize;
    }

    return Buffer.concat(frames);
  }

  decrypt(data: Buffer): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;

    while (offset < data.length) {
      const length = data.readUInt16LE(offset);
      const lengthBytes = data.subarray(offset, offset + 2);
      offset += 2;

      const ciphertext = data.subarray(offset, offset + length);
      offset += length;

      const tag = data.subarray(offset, offset + AUTH_TAG_LENGTH);
      offset += AUTH_TAG_LENGTH;

      const nonce = generateNonce(this.inCounter);
      this.inCounter++;

      const plaintext = decryptChaCha20(
        this.inKey,
        nonce,
        ciphertext,
        tag,
        lengthBytes,
      );
      parts.push(plaintext);
    }

    return Buffer.concat(parts);
  }
}
