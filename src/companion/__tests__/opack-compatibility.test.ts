import { describe, expect, it } from 'vitest';
import { opackDecode, opackEncode, OpackFloat } from '../opack.js';

// Independent wire fixtures, including published OPACK examples.
// These test protocol compatibility, rather than just this codec's round trips.
describe('Companion OPACK compatibility', () => {
  it('preserves a backward seek instead of decoding it as a huge positive integer', () => {
    expect(opackEncode(-10).toString('hex')).toBe('3600000000000024c0');
    expect(opackDecode(opackEncode(-10))).toBe(-10);
  });

  it('supports a combined session identifier with its top bit set', () => {
    const sessionId = 0x8000000000000001n;
    expect(opackEncode(sessionId).toString('hex')).toBe('330100000000000080');
    expect(opackDecode(opackEncode(sessionId))).toBe(sessionId);
  });

  it('decodes an app-list reply containing a repeated app-name reference', () => {
    const packet = Buffer.from(
      'e2425f740b425f63e24f636f6d2e6578616d706c652e6f6e654b4578616d706c65204170704f636f6d2e6578616d706c652e74776fa3',
      'hex',
    );
    expect(opackDecode(packet)).toEqual(new Map<string, unknown>([
      ['_t', 3],
      ['_c', new Map([
        ['com.example.one', 'Example App'],
        ['com.example.two', 'Example App'],
      ])],
    ]));
  });

  it('decodes the documented pointer example without indexing the boolean', () =>
    expect(opackDecode(Buffer.from('e3416102416244746573744163a2', 'hex')))
      .toEqual(new Map<string, unknown>([['a', false], ['b', 'test'], ['c', 'test']])));

  it.each([
    [30, '360000000000003e40'],
    [0, '360000000000000000'],
    [1, '36000000000000f03f'],
    [-10, '3600000000000024c0'],
  ])('preserves an explicit float wire type for %s', (value, hex) => {
    const encoded = opackEncode(new OpackFloat(value));
    expect(encoded.toString('hex')).toBe(hex);
    expect(opackDecode(encoded)).toBe(value);
  });

  it('keeps ordinary positive integers and negative zero distinct', () => {
    expect(opackEncode(30)).toEqual(Buffer.from([0x26]));
    expect(Object.is(opackDecode(opackEncode(-0)), -0)).toBe(true);
  });

  it('rejects unsigned overflow, negative bigint and imprecise integer input', () => {
    expect(() => opackEncode(1n << 64n)).toThrow(RangeError);
    expect(() => opackEncode(-1n)).toThrow(RangeError);
    expect(() => opackEncode(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(opackDecode(opackEncode((1n << 64n) - 1n))).toBe((1n << 64n) - 1n);
  });

  it('shares the object table across nested containers without indexing containers', () =>
    expect(opackDecode(Buffer.from('d343666f6fd1426261a1', 'hex')))
      .toEqual(['foo', ['ba'], 'ba']));

  it('does not add duplicate literals or references to the object table', () =>
    expect(opackDecode(Buffer.from('d543666f6f43666f6fa043626172a1', 'hex')))
      .toEqual(['foo', 'foo', 'foo', 'bar', 'bar']));

  it('preserves signed zero and byte-based deduplication in reference order', () => {
    const bytes = Buffer.from([0xab]);
    const literals = [new OpackFloat(0), new OpackFloat(-0), new OpackFloat(0), bytes, bytes, 'end'];
    const packet = Buffer.concat([
      Buffer.from([0xd7]), ...literals.map(opackEncode), Buffer.from([0xa3]),
    ]);
    expect(opackDecode(packet)).toEqual([0, -0, 0, bytes, bytes, 'end', 'end']);
  });

  it('gives equal values with different encodings separate reference slots, as the encoder does', () => {
    // int8 100, float64 100.0, then a reference to slot 1 (the float).
    const numbers = Buffer.concat([
      Buffer.from('d33064', 'hex'), opackEncode(new OpackFloat(100)), Buffer.from('a1', 'hex'),
    ]);
    expect(opackDecode(numbers)).toEqual([100, 100, 100]);
    // A UUID and a 16-byte data value with the same bytes, then a reference to slot 1 (the data).
    const bytes = Buffer.alloc(16, 0xab);
    const uuidAndData = Buffer.concat([
      Buffer.from('d305', 'hex'), bytes, Buffer.from('80', 'hex'), bytes, Buffer.from('a1', 'hex'),
    ]);
    expect(opackDecode(uuidAndData)).toEqual([bytes, bytes, bytes]);
  });

  it.each(['4361', '6103', '9203006162', 'd2'])('rejects truncated literal %s', hex =>
    expect(() => opackDecode(Buffer.from(hex, 'hex'))).toThrow(/end of buffer/));

  it.each([1, 2, 3, 4])('decodes an extended reference with %s index bytes', width => {
    const pointer = Buffer.alloc(1 + width);
    pointer[0] = 0xc0 + width;
    pointer.writeUIntLE(1, 1, width);
    expect(opackDecode(Buffer.concat([Buffer.from('d343666f6f43626172', 'hex'), pointer])))
      .toEqual(['foo', 'bar', 'bar']);
  });

  it('resets references between messages and rejects missing or truncated references', () => {
    expect(opackDecode(Buffer.from('d243666f6fa0', 'hex'))).toEqual(['foo', 'foo']);
    expect(() => opackDecode(Buffer.from('a0', 'hex'))).toThrow(/reference/);
    expect(() => opackDecode(Buffer.from('d243666f6fa1', 'hex'))).toThrow(/reference/);
    expect(() => opackDecode(Buffer.from('d243666f6fc2', 'hex'))).toThrow();
  });
});
