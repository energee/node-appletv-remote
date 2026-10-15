/**
 * OPACK encoder/decoder for the Apple Companion protocol.
 * OPACK is the compact binary serialization used for every Companion message body.
 */

/**
 * Any value OPACK can carry. Integers decode as `number` when safe, else `bigint`;
 * UUIDs decode as 16-byte Buffers; dicts are Maps so keys keep their OPACK types.
 */
export type OpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | OpackFloat
  | OpackValue[]
  | OpackDict;

/** An OPACK dictionary; insertion order is preserved on encode. */
export type OpackDict = Map<OpackValue, OpackValue>;

/**
 * Wrapper that forces float64 encoding. A plain integral `number` encodes as an OPACK
 * integer, but some fields (e.g. seconds, volume limits) must be floats on the wire.
 */
export class OpackFloat {
  constructor(readonly value: number) {}
}

// --- Type tags ---
const TAG_TRUE = 0x01;
const TAG_FALSE = 0x02;
/** Ends a 0xDF array or 0xEF dict whose count did not fit in the tag. */
const TAG_TERMINATOR = 0x03;
const TAG_NULL = 0x04;

// UUID: 0x05 + 16 raw bytes
const TAG_UUID = 0x05;

// Minus one: Apple encodes -1 as 0x07, the slot before the small integers.
const TAG_MINUS_ONE = 0x07;

// Small integers: 0x08 + value, for values 0..39
const TAG_SMALL_INT_BASE = 0x08;
const TAG_SMALL_INT_MAX_VALUE = 0x27; // 39

// Sized integers (little-endian): 0x30=1B, 0x31=2B, 0x32=4B, 0x33=8B
const TAG_INT8 = 0x30;
const TAG_INT16 = 0x31;
const TAG_INT32 = 0x32;
const TAG_INT64 = 0x33;

// Floats: 0x35=float32, 0x36=float64
const TAG_FLOAT32 = 0x35;
const TAG_FLOAT64 = 0x36;

// Strings: 0x40+len inline (len 0-32), 0x61=len8, 0x62=len16, 0x63=len24, 0x64=len32
const TAG_STRING_BASE = 0x40;
const TAG_STRING_LEN8 = 0x61;
const TAG_STRING_LEN16 = 0x62;
const TAG_STRING_LEN24 = 0x63;
const TAG_STRING_LEN32 = 0x64;

// Data/bytes: 0x70+len inline (len 0-32), 0x91=len8, 0x92=len16, 0x93=len32 (0x94=len64 is not supported)
const TAG_DATA_BASE = 0x70;
const TAG_DATA_LEN8 = 0x91;
const TAG_DATA_LEN16 = 0x92;
const TAG_DATA_LEN32 = 0x93;

// Arrays: 0xD0 + min(count, 0xF); if count >= 15 → 0xDF + items + 0x03
const TAG_ARRAY_BASE = 0xd0;
const TAG_ARRAY_OVERFLOW = 0x0f;

// Dicts: 0xE0 + min(count, 0xF); if count >= 15 → 0xEF + pairs + 0x03
const TAG_DICT_BASE = 0xe0;
const TAG_DICT_OVERFLOW = 0x0f;

// Object references (decode only): 0xA0+index inline (index 0-32), 0xC1..0xC4 = 1..4-byte LE index.
// The encoder never emits references.

// --- Encoder ---

/** Serialize a value to OPACK bytes. Never emits object references. */
export function opackEncode(value: OpackValue): Buffer {
  const parts: Buffer[] = [];
  encodeValue(value, parts);
  return Buffer.concat(parts);
}

/**
 * Append the encoding of one value to `parts`.
 * @throws {RangeError} for an unsafe integer `number` (pass a bigint instead)
 * @throws {Error} for a value of no OPACK type
 */
function encodeValue(value: OpackValue, parts: Buffer[]): void {
  if (value === null) {
    parts.push(Buffer.from([TAG_NULL]));
    return;
  }

  if (typeof value === 'boolean') {
    parts.push(Buffer.from([value ? TAG_TRUE : TAG_FALSE]));
    return;
  }

  if (typeof value === 'bigint') {
    encodeBigInt(value, parts);
    return;
  }

  if (typeof value === 'number') {
    // OPACK integers are unsigned. Negative numbers must use a float.
    if (Number.isInteger(value) && value >= 0 && !Object.is(value, -0)) {
      if (!Number.isSafeInteger(value)) {
        throw new RangeError('Use bigint for OPACK integers above Number.MAX_SAFE_INTEGER');
      }
      encodeInteger(value, parts);
    } else {
      encodeFloat(value, parts);
    }
    return;
  }

  if (value instanceof OpackFloat) {
    encodeFloat(value.value, parts);
    return;
  }

  if (typeof value === 'string') {
    encodeString(value, parts);
    return;
  }

  if (Buffer.isBuffer(value)) {
    encodeData(value, parts);
    return;
  }

  if (Array.isArray(value)) {
    encodeArray(value, parts);
    return;
  }

  if (value instanceof Map) {
    encodeDict(value, parts);
    return;
  }

  throw new Error(`Unsupported OPACK type: ${typeof value}`);
}

/** Encode a non-negative integer in the smallest unsigned form (inline, then 1/2/4/8 bytes LE). */
function encodeInteger(value: number, parts: Buffer[]): void {
  // Small integers 0..39 encoded inline as (value + 0x08)
  if (value >= 0 && value <= TAG_SMALL_INT_MAX_VALUE) {
    parts.push(Buffer.from([TAG_SMALL_INT_BASE + value]));
    return;
  }

  if (value >= 0 && value <= 0xff) {
    const buf = Buffer.alloc(2);
    buf[0] = TAG_INT8;
    buf.writeUInt8(value, 1);
    parts.push(buf);
    return;
  }

  if (value >= 0 && value <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = TAG_INT16;
    buf.writeUInt16LE(value, 1);
    parts.push(buf);
    return;
  }

  if (value >= 0 && value <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf[0] = TAG_INT32;
    buf.writeUInt32LE(value, 1);
    parts.push(buf);
    return;
  }

  encodeBigInt(BigInt(value), parts);
}

/** Encode as an 8-byte unsigned LE integer regardless of magnitude; throws if negative or over 64 bits. */
function encodeBigInt(value: bigint, parts: Buffer[]): void {
  const buf = Buffer.alloc(9);
  buf[0] = TAG_INT64;
  buf.writeBigUInt64LE(value, 1);
  parts.push(buf);
}

/** Encode as float64; float32 is decoded but never produced. */
function encodeFloat(value: number, parts: Buffer[]): void {
  const buf = Buffer.alloc(9);
  buf[0] = TAG_FLOAT64;
  buf.writeDoubleLE(value, 1);
  parts.push(buf);
}

/** Encode a UTF-8 string with an inline or 1/2/3/4-byte LE length prefix. */
function encodeString(value: string, parts: Buffer[]): void {
  const data = Buffer.from(value, 'utf-8');
  const len = data.length;

  if (len <= 0x20) {
    parts.push(Buffer.from([TAG_STRING_BASE + len]));
  } else if (len <= 0xff) {
    parts.push(Buffer.from([TAG_STRING_LEN8, len]));
  } else if (len <= 0xffff) {
    const header = Buffer.alloc(3);
    header[0] = TAG_STRING_LEN16;
    header.writeUInt16LE(len, 1);
    parts.push(header);
  } else if (len <= 0xffffff) {
    const header = Buffer.alloc(4);
    header[0] = TAG_STRING_LEN24;
    header.writeUIntLE(len, 1, 3);
    parts.push(header);
  } else {
    const header = Buffer.alloc(5);
    header[0] = TAG_STRING_LEN32;
    header.writeUInt32LE(len, 1);
    parts.push(header);
  }
  parts.push(data);
}

/** Encode raw bytes with an inline or 1/2/4-byte LE length prefix. */
function encodeData(value: Buffer, parts: Buffer[]): void {
  const len = value.length;

  if (len <= 0x20) {
    parts.push(Buffer.from([TAG_DATA_BASE + len]));
  } else if (len <= 0xff) {
    parts.push(Buffer.from([TAG_DATA_LEN8, len]));
  } else if (len <= 0xffff) {
    const header = Buffer.alloc(3);
    header[0] = TAG_DATA_LEN16;
    header.writeUInt16LE(len, 1);
    parts.push(header);
  } else {
    const header = Buffer.alloc(5);
    header[0] = TAG_DATA_LEN32;
    header.writeUInt32LE(len, 1);
    parts.push(header);
  }
  parts.push(value);
}

/** Encode an array; 15 or more items use the open-count tag plus a terminator. */
function encodeArray(value: OpackValue[], parts: Buffer[]): void {
  const count = value.length;
  parts.push(Buffer.from([TAG_ARRAY_BASE + Math.min(count, TAG_ARRAY_OVERFLOW)]));
  for (const item of value) {
    encodeValue(item, parts);
  }
  if (count >= TAG_ARRAY_OVERFLOW) {
    parts.push(Buffer.from([TAG_TERMINATOR]));
  }
}

/** Encode a dict as alternating key/value; 15 or more pairs use the open-count tag plus a terminator. */
function encodeDict(value: OpackDict, parts: Buffer[]): void {
  const count = value.size;
  parts.push(Buffer.from([TAG_DICT_BASE + Math.min(count, TAG_DICT_OVERFLOW)]));
  for (const [k, v] of value) {
    encodeValue(k, parts);
    encodeValue(v, parts);
  }
  if (count >= TAG_DICT_OVERFLOW) {
    parts.push(Buffer.from([TAG_TERMINATOR]));
  }
}

// --- Decoder ---

/**
 * Decode the first OPACK value in `buffer`, resolving object references.
 * Trailing bytes after that value are ignored.
 * @throws {Error} on an unknown tag, a bad object reference, or a truncated buffer
 */
export function opackDecode(buffer: Buffer): OpackValue {
  const result = decodeValue(buffer, 0, { objects: [], seen: new Set() });
  return result.value;
}

/** A decoded value and the offset just past its encoding. */
interface DecodeResult {
  value: OpackValue;
  offset: number;
}

/** Per-decode state for object references. */
interface DecodeContext {
  /** Previously decoded literals, indexed by reference tags. */
  objects: OpackValue[];
  /** Encoded bytes (as latin1) of literals already in `objects`, to avoid duplicate slots. */
  seen: Set<string>;
}

/**
 * Decode one value at `offset`, resolving object-reference tags and recording each
 * multi-byte literal (not arrays or dicts) in the reference table.
 */
function decodeValue(buf: Buffer, offset: number, context: DecodeContext): DecodeResult {
  const { objects, seen } = context;
  const tag = buf[offset];
  if (tag >= 0xa0 && tag <= 0xc4) {
    const width = tag <= 0xc0 ? 0 : tag - 0xc0;
    const index = width === 0 ? tag - 0xa0 : buf.readUIntLE(offset + 1, width);
    if (index >= objects.length) {
      throw new Error(`OPACK: invalid object reference ${index}`);
    }
    return { value: objects[index], offset: offset + 1 + width };
  }

  const result = decodeLiteral(buf, offset, context);
  // subarray clamps a short read, so a literal claiming more bytes than remain would decode truncated.
  if (result.offset > buf.length) {
    throw new Error('OPACK: unexpected end of buffer');
  }
  const value = result.value;
  // Deduplicate by encoded bytes rather than by value, so equal values with different
  // encodings (int 100 vs float 100.0, UUID vs data) keep separate reference slots.
  // ponytail: latin1 key copies each literal once; switch to length-bucketed Buffer.equals if large replies get hot.
  if (result.offset - offset > 1 && !Array.isArray(value) && !(value instanceof Map)) {
    const key = buf.toString('latin1', offset, result.offset);
    if (!seen.has(key)) {
      seen.add(key);
      objects.push(value);
    }
  }
  return result;
}

/** Decode one non-reference value at `offset`. Containers recurse through decodeValue. */
function decodeLiteral(buf: Buffer, offset: number, context: DecodeContext): DecodeResult {
  if (offset >= buf.length) {
    throw new Error('OPACK: unexpected end of buffer');
  }

  const tag = buf[offset];

  // Null
  if (tag === TAG_NULL) {
    return { value: null, offset: offset + 1 };
  }

  // Boolean
  if (tag === TAG_TRUE) {
    return { value: true, offset: offset + 1 };
  }
  if (tag === TAG_FALSE) {
    return { value: false, offset: offset + 1 };
  }

  // UUID (16 bytes)
  if (tag === TAG_UUID) {
    return { value: Buffer.from(buf.subarray(offset + 1, offset + 17)), offset: offset + 17 };
  }

  if (tag === TAG_MINUS_ONE) {
    return { value: -1, offset: offset + 1 };
  }

  // Small integers 0..39: tags 0x08..0x2F
  if (tag >= TAG_SMALL_INT_BASE && tag <= TAG_SMALL_INT_BASE + TAG_SMALL_INT_MAX_VALUE) {
    return { value: tag - TAG_SMALL_INT_BASE, offset: offset + 1 };
  }

  // Sized integers (unsigned LE). 8-byte values become bigint only above MAX_SAFE_INTEGER.
  if (tag === TAG_INT8) {
    return { value: buf.readUInt8(offset + 1), offset: offset + 2 };
  }
  if (tag === TAG_INT16) {
    return { value: buf.readUInt16LE(offset + 1), offset: offset + 3 };
  }
  if (tag === TAG_INT32) {
    return { value: buf.readUInt32LE(offset + 1), offset: offset + 5 };
  }
  if (tag === TAG_INT64) {
    const val = buf.readBigUInt64LE(offset + 1);
    if (val <= Number.MAX_SAFE_INTEGER) {
      return { value: Number(val), offset: offset + 9 };
    }
    return { value: val, offset: offset + 9 };
  }

  // Floats
  if (tag === TAG_FLOAT32) {
    return { value: buf.readFloatLE(offset + 1), offset: offset + 5 };
  }
  if (tag === TAG_FLOAT64) {
    return { value: buf.readDoubleLE(offset + 1), offset: offset + 9 };
  }

  // Strings: inline 0x40..0x60
  if (tag >= TAG_STRING_BASE && tag <= TAG_STRING_BASE + 0x20) {
    const len = tag - TAG_STRING_BASE;
    const str = buf.subarray(offset + 1, offset + 1 + len).toString('utf-8');
    return { value: str, offset: offset + 1 + len };
  }
  if (tag === TAG_STRING_LEN8) {
    const len = buf[offset + 1];
    const str = buf.subarray(offset + 2, offset + 2 + len).toString('utf-8');
    return { value: str, offset: offset + 2 + len };
  }
  if (tag === TAG_STRING_LEN16) {
    const len = buf.readUInt16LE(offset + 1);
    const str = buf.subarray(offset + 3, offset + 3 + len).toString('utf-8');
    return { value: str, offset: offset + 3 + len };
  }
  if (tag === TAG_STRING_LEN24) {
    const len = buf.readUIntLE(offset + 1, 3);
    const str = buf.subarray(offset + 4, offset + 4 + len).toString('utf-8');
    return { value: str, offset: offset + 4 + len };
  }
  if (tag === TAG_STRING_LEN32) {
    const len = buf.readUInt32LE(offset + 1);
    const str = buf.subarray(offset + 5, offset + 5 + len).toString('utf-8');
    return { value: str, offset: offset + 5 + len };
  }

  // Data/bytes: inline 0x70..0x90
  if (tag >= TAG_DATA_BASE && tag <= TAG_DATA_BASE + 0x20) {
    const len = tag - TAG_DATA_BASE;
    const data = Buffer.from(buf.subarray(offset + 1, offset + 1 + len));
    return { value: data, offset: offset + 1 + len };
  }
  if (tag === TAG_DATA_LEN8) {
    const len = buf[offset + 1];
    const data = Buffer.from(buf.subarray(offset + 2, offset + 2 + len));
    return { value: data, offset: offset + 2 + len };
  }
  if (tag === TAG_DATA_LEN16) {
    const len = buf.readUInt16LE(offset + 1);
    const data = Buffer.from(buf.subarray(offset + 3, offset + 3 + len));
    return { value: data, offset: offset + 3 + len };
  }
  if (tag === TAG_DATA_LEN32) {
    const len = buf.readUInt32LE(offset + 1);
    const data = Buffer.from(buf.subarray(offset + 5, offset + 5 + len));
    return { value: data, offset: offset + 5 + len };
  }

  // Arrays: 0xD0..0xDE inline count, 0xDF = terminated
  if (tag >= TAG_ARRAY_BASE && tag < TAG_ARRAY_BASE + TAG_ARRAY_OVERFLOW) {
    const count = tag - TAG_ARRAY_BASE;
    return decodeArrayN(buf, offset + 1, count, context);
  }
  if (tag === TAG_ARRAY_BASE + TAG_ARRAY_OVERFLOW) {
    return decodeArrayTerminated(buf, offset + 1, context);
  }

  // Dicts: 0xE0..0xEE inline count, 0xEF = terminated
  if (tag >= TAG_DICT_BASE && tag < TAG_DICT_BASE + TAG_DICT_OVERFLOW) {
    const count = tag - TAG_DICT_BASE;
    return decodeDictN(buf, offset + 1, count, context);
  }
  if (tag === TAG_DICT_BASE + TAG_DICT_OVERFLOW) {
    return decodeDictTerminated(buf, offset + 1, context);
  }

  throw new Error(`OPACK: unknown tag 0x${tag.toString(16)} at offset ${offset}`);
}

/** Decode an array whose item count was carried in the tag. */
function decodeArrayN(buf: Buffer, offset: number, count: number, context: DecodeContext): DecodeResult {
  const arr: OpackValue[] = [];
  for (let i = 0; i < count; i++) {
    const item = decodeValue(buf, offset, context);
    arr.push(item.value);
    offset = item.offset;
  }
  return { value: arr, offset };
}

/** Decode items until a terminator; a missing terminator at end of buffer is tolerated. */
function decodeArrayTerminated(buf: Buffer, offset: number, context: DecodeContext): DecodeResult {
  const arr: OpackValue[] = [];
  while (offset < buf.length && buf[offset] !== TAG_TERMINATOR) {
    const item = decodeValue(buf, offset, context);
    arr.push(item.value);
    offset = item.offset;
  }
  if (offset < buf.length && buf[offset] === TAG_TERMINATOR) {
    offset++;
  }
  return { value: arr, offset };
}

/** Decode a dict whose pair count was carried in the tag. */
function decodeDictN(buf: Buffer, offset: number, count: number, context: DecodeContext): DecodeResult {
  const dict: OpackDict = new Map();
  for (let i = 0; i < count; i++) {
    const key = decodeValue(buf, offset, context);
    offset = key.offset;
    const val = decodeValue(buf, offset, context);
    offset = val.offset;
    dict.set(key.value, val.value);
  }
  return { value: dict, offset };
}

/** Decode pairs until a terminator; a missing terminator at end of buffer is tolerated. */
function decodeDictTerminated(buf: Buffer, offset: number, context: DecodeContext): DecodeResult {
  const dict: OpackDict = new Map();
  while (offset < buf.length && buf[offset] !== TAG_TERMINATOR) {
    const key = decodeValue(buf, offset, context);
    offset = key.offset;
    const val = decodeValue(buf, offset, context);
    offset = val.offset;
    dict.set(key.value, val.value);
  }
  if (offset < buf.length && buf[offset] === TAG_TERMINATOR) {
    offset++;
  }
  return { value: dict, offset };
}
