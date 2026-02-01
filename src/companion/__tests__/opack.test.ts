import { describe, it, expect } from 'vitest';
import { opackEncode, opackDecode, type OpackDict, type OpackValue } from '../opack.js';

describe('OPACK', () => {
  describe('primitives', () => {
    it('encodes and decodes null', () => {
      const buf = opackEncode(null);
      expect(buf).toEqual(Buffer.from([0x04]));
      expect(opackDecode(buf)).toBeNull();
    });

    it('encodes and decodes true', () => {
      const buf = opackEncode(true);
      expect(buf).toEqual(Buffer.from([0x01]));
      expect(opackDecode(buf)).toBe(true);
    });

    it('encodes and decodes false', () => {
      const buf = opackEncode(false);
      expect(buf).toEqual(Buffer.from([0x02]));
      expect(opackDecode(buf)).toBe(false);
    });
  });

  describe('integers', () => {
    it('encodes small integers 0-20 inline', () => {
      for (let i = 0; i <= 20; i++) {
        const buf = opackEncode(i);
        expect(buf.length).toBe(1);
        expect(buf[0]).toBe(0x20 + i);
        expect(opackDecode(buf)).toBe(i);
      }
    });

    it('encodes int8 values', () => {
      const buf = opackEncode(-1);
      expect(buf[0]).toBe(0x06); // TAG_INT8
      expect(opackDecode(buf)).toBe(-1);

      const buf2 = opackEncode(100);
      expect(buf2[0]).toBe(0x06); // TAG_INT8
      expect(opackDecode(buf2)).toBe(100);
    });

    it('encodes int16 values', () => {
      const buf = opackEncode(1000);
      expect(buf[0]).toBe(0x07); // TAG_INT16
      expect(opackDecode(buf)).toBe(1000);

      const buf2 = opackEncode(-500);
      expect(buf2[0]).toBe(0x07);
      expect(opackDecode(buf2)).toBe(-500);
    });

    it('encodes int32 values', () => {
      const buf = opackEncode(100000);
      expect(buf[0]).toBe(0x08); // TAG_INT32
      expect(opackDecode(buf)).toBe(100000);
    });

    it('encodes int64 values via bigint', () => {
      const big = BigInt('9007199254740993'); // > MAX_SAFE_INTEGER
      const buf = opackEncode(big);
      expect(buf[0]).toBe(0x09); // TAG_INT64
      expect(opackDecode(buf)).toBe(big);
    });
  });

  describe('floats', () => {
    it('encodes and decodes float64', () => {
      const buf = opackEncode(3.14);
      expect(buf[0]).toBe(0x36); // TAG_FLOAT64
      expect(opackDecode(buf)).toBeCloseTo(3.14, 10);
    });
  });

  describe('strings', () => {
    it('encodes short strings inline', () => {
      const buf = opackEncode('hi');
      expect(buf[0]).toBe(0x40 + 2); // TAG_STRING_BASE + length
      expect(opackDecode(buf)).toBe('hi');
    });

    it('encodes empty string', () => {
      const buf = opackEncode('');
      expect(buf[0]).toBe(0x40); // TAG_STRING_BASE + 0
      expect(opackDecode(buf)).toBe('');
    });

    it('encodes longer strings with len8', () => {
      const str = 'a'.repeat(50);
      const buf = opackEncode(str);
      expect(buf[0]).toBe(0x61); // TAG_STRING_LEN8
      expect(buf[1]).toBe(50);
      expect(opackDecode(buf)).toBe(str);
    });

    it('handles UTF-8 strings', () => {
      const str = 'héllo 🌍';
      const buf = opackEncode(str);
      expect(opackDecode(buf)).toBe(str);
    });
  });

  describe('data (Buffer)', () => {
    it('encodes short data inline', () => {
      const data = Buffer.from([1, 2, 3]);
      const buf = opackEncode(data);
      expect(buf[0]).toBe(0x70 + 3); // TAG_DATA_BASE + length
      const decoded = opackDecode(buf);
      expect(Buffer.isBuffer(decoded)).toBe(true);
      expect(decoded).toEqual(data);
    });

    it('encodes empty data', () => {
      const data = Buffer.alloc(0);
      const buf = opackEncode(data);
      expect(buf[0]).toBe(0x70); // TAG_DATA_BASE + 0
      const decoded = opackDecode(buf) as Buffer;
      expect(decoded.length).toBe(0);
    });

    it('encodes longer data with len8', () => {
      const data = Buffer.alloc(100, 0xab);
      const buf = opackEncode(data);
      expect(buf[0]).toBe(0x91); // TAG_DATA_LEN8
      expect(opackDecode(buf)).toEqual(data);
    });
  });

  describe('arrays', () => {
    it('encodes small arrays inline', () => {
      const arr = [1, 'hello', true];
      const buf = opackEncode(arr);
      expect(buf[0]).toBe(0xd0 + 3); // TAG_ARRAY_BASE + 3
      const decoded = opackDecode(buf) as unknown[];
      expect(decoded).toEqual(arr);
    });

    it('encodes empty arrays', () => {
      const buf = opackEncode([]);
      expect(buf[0]).toBe(0xd0); // TAG_ARRAY_BASE + 0
      expect(opackDecode(buf)).toEqual([]);
    });

    it('encodes large arrays with terminator', () => {
      const arr = Array.from({ length: 20 }, (_, i) => i);
      const buf = opackEncode(arr);
      expect(buf[0]).toBe(0xe1); // TAG_ARRAY_TERMINATED
      expect(opackDecode(buf)).toEqual(arr);
    });
  });

  describe('dicts', () => {
    it('encodes small dicts inline', () => {
      const dict: OpackDict = new Map<OpackValue, OpackValue>([
        ['key', 'value'],
        ['num', 42],
      ]);
      const buf = opackEncode(dict);
      expect(buf[0]).toBe(0xe2 + 4); // TAG_DICT_BASE + 2*2
      const decoded = opackDecode(buf) as OpackDict;
      expect(decoded.get('key')).toBe('value');
      expect(decoded.get('num')).toBe(42);
    });

    it('encodes empty dicts', () => {
      const dict: OpackDict = new Map();
      const buf = opackEncode(dict);
      expect(buf[0]).toBe(0xe2); // TAG_DICT_BASE + 0
      const decoded = opackDecode(buf) as OpackDict;
      expect(decoded.size).toBe(0);
    });

    it('handles nested structures', () => {
      const inner: OpackDict = new Map<OpackValue, OpackValue>([['nested', true]]);
      const dict: OpackDict = new Map<OpackValue, OpackValue>([
        ['arr', [1, 2, 3]],
        ['dict', inner],
        ['null', null],
      ]);
      const buf = opackEncode(dict);
      const decoded = opackDecode(buf) as OpackDict;
      expect(decoded.get('arr')).toEqual([1, 2, 3]);
      expect((decoded.get('dict') as OpackDict).get('nested')).toBe(true);
      expect(decoded.get('null')).toBeNull();
    });
  });

  describe('roundtrip', () => {
    it('roundtrips complex message', () => {
      const msg: OpackDict = new Map<string, unknown>([
        ['_i', '_sessionStart'],
        ['_t', 1],
        ['_srvT', 'com.apple.tvremoteservices'],
        ['_sid', 42],
      ]) as OpackDict;
      const buf = opackEncode(msg);
      const decoded = opackDecode(buf) as OpackDict;
      expect(decoded.get('_i')).toBe('_sessionStart');
      expect(decoded.get('_t')).toBe(1);
      expect(decoded.get('_srvT')).toBe('com.apple.tvremoteservices');
      expect(decoded.get('_sid')).toBe(42);
    });
  });
});
