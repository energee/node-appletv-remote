/**
 * Companion protocol frame parser and encoder.
 * Frame format: 1-byte type + 3-byte big-endian payload length + payload.
 * Used unencrypted during pair-setup/pair-verify; CompanionSession reuses the header layout afterwards.
 */

/** Companion frame type byte (first byte of every frame header). */
export enum FrameType {
  /** Pair-setup, first message (M1). */
  PS_Start = 0x03,
  /** Pair-setup, every message after M1. */
  PS_Next = 0x04,
  /** Pair-verify, first message (M1). */
  PV_Start = 0x05,
  /** Pair-verify, every message after M1. */
  PV_Next = 0x06,
  /** Encrypted OPACK message, used once pair-verify has established session keys. */
  E_OPACK = 0x08,
}

/** One decoded frame: its type byte and the raw (still OPACK-encoded) payload. */
export interface Frame {
  type: FrameType;
  payload: Buffer;
}

/** Frame header length: 1 byte type + 3 bytes length. */
const HEADER_SIZE = 4;

/**
 * Build a frame from a type and payload. Does not check the payload fits the 3-byte
 * length field; payloads over 16 MiB would have their length silently truncated.
 */
export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header[0] = type;
  // 3-byte big-endian length
  header[1] = (payload.length >> 16) & 0xff;
  header[2] = (payload.length >> 8) & 0xff;
  header[3] = payload.length & 0xff;
  return Buffer.concat([header, payload]);
}

/**
 * Split a byte stream into every complete frame it contains.
 * Payloads and the remainder are copies, so the caller may discard `buffer`.
 * @returns the complete frames, plus any trailing bytes of a partial frame to prepend to the next read
 */
export function parseFrames(buffer: Buffer): { frames: Frame[]; remainder: Buffer } {
  const frames: Frame[] = [];
  let offset = 0;

  while (offset + HEADER_SIZE <= buffer.length) {
    const type = buffer[offset] as FrameType;
    const length =
      (buffer[offset + 1] << 16) |
      (buffer[offset + 2] << 8) |
      buffer[offset + 3];

    if (offset + HEADER_SIZE + length > buffer.length) {
      break; // incomplete frame
    }

    const payload = Buffer.from(
      buffer.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length),
    );
    frames.push({ type, payload });
    offset += HEADER_SIZE + length;
  }

  return { frames, remainder: Buffer.from(buffer.subarray(offset)) };
}
