/**
 * OPACK encoder/decoder for the Apple Companion protocol.
 * OPACK is a compact binary serialization format used for Companion protocol messages.
 * Tag values matched to pyatv's opack.py implementation.
 */

export type OpackValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | OpackValue[]
  | OpackDict;

export type OpackDict = Map<OpackValue, OpackValue>;

// --- Type tags (matched to pyatv) ---
const TAG_NULL = 0x04;
const TAG_TRUE = 0x01;
const TAG_FALSE = 0x02;
const TAG_TERMINATOR = 0x03;

// UUID: 0x05 + 16 raw bytes
const TAG_UUID = 0x05;

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

// Data/bytes: 0x70+len inline (len 0-32), 0x91=len8, 0x92=len16, 0x93=len32, 0x94=len64
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

// --- Encoder ---

export function opackEncode(value: OpackValue): Buffer {
  const parts: Buffer[] = [];
  encodeValue(value, parts);
  return Buffer.concat(parts);
}

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
    if (Number.isInteger(value)) {
      encodeInteger(value, parts);
    } else {
      encodeFloat(value, parts);
    }
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

  // Fall through to int64
  const buf = Buffer.alloc(9);
  buf[0] = TAG_INT64;
  buf.writeBigInt64LE(BigInt(value), 1);
  parts.push(buf);
}

function encodeBigInt(value: bigint, parts: Buffer[]): void {
  const buf = Buffer.alloc(9);
  buf[0] = TAG_INT64;
  buf.writeBigInt64LE(value, 1);
  parts.push(buf);
}

function encodeFloat(value: number, parts: Buffer[]): void {
  const buf = Buffer.alloc(9);
  buf[0] = TAG_FLOAT64;
  buf.writeDoubleLE(value, 1);
  parts.push(buf);
}

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

export function opackDecode(buffer: Buffer): OpackValue {
  const result = decodeValue(buffer, 0);
  return result.value;
}

interface DecodeResult {
  value: OpackValue;
  offset: number;
}

function decodeValue(buf: Buffer, offset: number): DecodeResult {
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

  // Small integers 0..39: tags 0x08..0x2F
  if (tag >= TAG_SMALL_INT_BASE && tag <= TAG_SMALL_INT_BASE + TAG_SMALL_INT_MAX_VALUE) {
    return { value: tag - TAG_SMALL_INT_BASE, offset: offset + 1 };
  }

  // Sized integers (unsigned LE)
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
    return decodeArrayN(buf, offset + 1, count);
  }
  if (tag === TAG_ARRAY_BASE + TAG_ARRAY_OVERFLOW) {
    return decodeArrayTerminated(buf, offset + 1);
  }

  // Dicts: 0xE0..0xEE inline count, 0xEF = terminated
  if (tag >= TAG_DICT_BASE && tag < TAG_DICT_BASE + TAG_DICT_OVERFLOW) {
    const count = tag - TAG_DICT_BASE;
    return decodeDictN(buf, offset + 1, count);
  }
  if (tag === TAG_DICT_BASE + TAG_DICT_OVERFLOW) {
    return decodeDictTerminated(buf, offset + 1);
  }

  throw new Error(`OPACK: unknown tag 0x${tag.toString(16)} at offset ${offset}`);
}

function decodeArrayN(buf: Buffer, offset: number, count: number): DecodeResult {
  const arr: OpackValue[] = [];
  for (let i = 0; i < count; i++) {
    const item = decodeValue(buf, offset);
    arr.push(item.value);
    offset = item.offset;
  }
  return { value: arr, offset };
}

function decodeArrayTerminated(buf: Buffer, offset: number): DecodeResult {
  const arr: OpackValue[] = [];
  while (offset < buf.length && buf[offset] !== TAG_TERMINATOR) {
    const item = decodeValue(buf, offset);
    arr.push(item.value);
    offset = item.offset;
  }
  if (offset < buf.length && buf[offset] === TAG_TERMINATOR) {
    offset++;
  }
  return { value: arr, offset };
}

function decodeDictN(buf: Buffer, offset: number, count: number): DecodeResult {
  const dict: OpackDict = new Map();
  for (let i = 0; i < count; i++) {
    const key = decodeValue(buf, offset);
    offset = key.offset;
    const val = decodeValue(buf, offset);
    offset = val.offset;
    dict.set(key.value, val.value);
  }
  return { value: dict, offset };
}

function decodeDictTerminated(buf: Buffer, offset: number): DecodeResult {
  const dict: OpackDict = new Map();
  while (offset < buf.length && buf[offset] !== TAG_TERMINATOR) {
    const key = decodeValue(buf, offset);
    offset = key.offset;
    const val = decodeValue(buf, offset);
    offset = val.offset;
    dict.set(key.value, val.value);
  }
  if (offset < buf.length && buf[offset] === TAG_TERMINATOR) {
    offset++;
  }
  return { value: dict, offset };
}
