/**
 * AirPlay DataStream framing for the MRP-over-AirPlay data channel: a 32-byte header
 * followed by a binary plist whose `params.data` holds a varint-length-prefixed protobuf.
 */

import bplistCreator from 'bplist-creator';
import { parseBuffer } from 'bplist-parser';

/** Encode a non-negative integer (up to 2^32 - 1) as a protobuf-style unsigned varint. */
export function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Decode a protobuf-style unsigned varint at `offset`. Exact up to 2^53
 * (Number.MAX_SAFE_INTEGER). Stops at end of buffer if no terminator is found.
 */
export function decodeVarint(buf: Buffer, offset = 0): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset + bytesRead < buf.length) {
    const byte = buf[offset + bytesRead];
    value += (byte & 0x7f) * 2 ** shift;  // not `<<`: bitwise ops truncate to int32
    bytesRead++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return { value, bytesRead };
}

/**
 * Header layout: size (4B BE, includes header) | message type (12B, "sync"/"rply" + NULs) |
 * command (4B) | seqno (8B BE) | padding (4B).
 */
const HEADER_SIZE = 32;
const MESSAGE_TYPE = Buffer.from('sync\0\0\0\0\0\0\0\0', 'binary');  // "sync" + 8 null bytes = 12 bytes
const COMMAND = Buffer.from('comm', 'ascii');  // 4 bytes

/**
 * Sequence number for every outgoing sync frame. Mirrors pyatv: one random value in
 * [0x100000000, 0x1FFFFFFFF) chosen at module load and reused for all messages (never incremented).
 */
const globalSeqno = BigInt(0x100000000) + BigInt(Math.floor(Math.random() * 0xFFFFFFFF));

/** Wrap an encoded MRP protobuf message in a DataStream "sync"/"comm" frame. */
export function buildDataStreamFrame(protobufData: Buffer): Buffer {
  const varintPrefix = encodeVarint(protobufData.length);
  const prefixedData = Buffer.concat([varintPrefix, protobufData]);

  const plistPayload = bplistCreator({
    params: {
      data: prefixedData,
    },
  });

  const totalSize = HEADER_SIZE + plistPayload.length;
  const header = Buffer.alloc(HEADER_SIZE);

  let offset = 0;
  // size (4B BE): total frame size including header
  header.writeUInt32BE(totalSize, offset);
  offset += 4;

  // message_type (12B): "sync" + 8 null bytes
  MESSAGE_TYPE.copy(header, offset);
  offset += 12;

  // command (4B): "comm"
  COMMAND.copy(header, offset);
  offset += 4;

  // seqno (8B BE): same value for all outgoing messages (pyatv behavior)
  header.writeBigUInt64BE(globalSeqno, offset);
  offset += 8;

  // padding (4B): zeros (already zero from alloc)

  return Buffer.concat([header, plistPayload]);
}

/** A DataStream frame decoded by `parseDataStreamFrame`. */
export interface ParsedDataStreamFrame {
  /** Any type other than "rply" is reported as "sync". */
  messageType: 'sync' | 'rply';
  /** The MRP protobuf payload, or null when the frame has no `params.data` or its plist is unparseable. */
  protobufData: Buffer | null;
  seqno: bigint;
  /** Bytes the frame occupies in the input, header included; advance the buffer by this much. */
  totalSize: number;
}

/**
 * Parse one frame starting at `offset`. Returns null if the buffer does not yet hold the
 * whole frame. Plist parse errors are swallowed and reported as a frame with null payload.
 */
export function parseDataStreamFrame(buf: Buffer, offset = 0): ParsedDataStreamFrame | null {
  if (buf.length - offset < HEADER_SIZE) return null;

  const totalSize = buf.readUInt32BE(offset);
  if (buf.length - offset < totalSize) return null;

  const messageTypeStr = buf.subarray(offset + 4, offset + 8).toString('ascii');
  const messageType = messageTypeStr === 'rply' ? 'rply' as const : 'sync' as const;
  const seqno = buf.readBigUInt64BE(offset + 20);

  if (totalSize <= HEADER_SIZE) {
    return { messageType, protobufData: null, seqno, totalSize };
  }

  const plistBuf = buf.subarray(offset + HEADER_SIZE, offset + totalSize);

  try {
    const parsed = parseBuffer(plistBuf);
    const payload = parsed[0] as Record<string, unknown>;
    const params = payload?.params as Record<string, unknown> | undefined;
    const data = params?.data as Buffer | undefined;

    if (!data) {
      // Empty payload (e.g., rply with just {})
      return { messageType, protobufData: null, seqno, totalSize };
    }

    const { value: protoLength, bytesRead } = decodeVarint(data, 0);
    const protobufData = data.subarray(bytesRead, bytesRead + protoLength);
    return { messageType, protobufData, seqno, totalSize };
  } catch {
    return { messageType, protobufData: null, seqno, totalSize };
  }
}

/** Build a header-only "rply" frame acknowledging the received sync frame with `seqno`. */
export function buildDataStreamReply(seqno: bigint): Buffer {
  const REPLY_TYPE = Buffer.from('rply\0\0\0\0\0\0\0\0', 'binary');
  const header = Buffer.alloc(HEADER_SIZE);

  let offset = 0;
  header.writeUInt32BE(HEADER_SIZE, offset);  // size = just the header, no payload
  offset += 4;
  REPLY_TYPE.copy(header, offset);
  offset += 12;
  // command: 4 null bytes
  offset += 4;
  header.writeBigUInt64BE(seqno, offset);
  // padding remains zero

  return header;
}
