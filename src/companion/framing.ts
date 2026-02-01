/**
 * Companion protocol frame parser and encoder.
 * Frame format: 1-byte type + 3-byte BE payload length + payload
 */

export enum FrameType {
  PS_Start = 0x03,
  PS_Next = 0x04,
  PV_Start = 0x05,
  PV_Next = 0x06,
  E_OPACK = 0x08,
}

export interface Frame {
  type: FrameType;
  payload: Buffer;
}

const HEADER_SIZE = 4; // 1 byte type + 3 bytes length

export function encodeFrame(type: FrameType, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header[0] = type;
  // 3-byte big-endian length
  header[1] = (payload.length >> 16) & 0xff;
  header[2] = (payload.length >> 8) & 0xff;
  header[3] = payload.length & 0xff;
  return Buffer.concat([header, payload]);
}

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
