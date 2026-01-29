import { describe, it, expect } from 'vitest';
import { TlvTag, tlvEncode, tlvDecode } from '../tlv.js';

describe('TLV8', () => {
  it('encodes a single short value', () => {
    const result = tlvEncode({ [TlvTag.SeqNo]: Buffer.from([0x01]) });
    expect(result).toEqual(Buffer.from([0x06, 0x01, 0x01]));
  });

  it('decodes a single short value', () => {
    const result = tlvDecode(Buffer.from([0x06, 0x01, 0x01]));
    expect(result[TlvTag.SeqNo]).toEqual(Buffer.from([0x01]));
  });

  it('fragments values over 255 bytes', () => {
    const bigValue = Buffer.alloc(300, 0xAA);
    const encoded = tlvEncode({ [TlvTag.PublicKey]: bigValue });
    expect(encoded.length).toBe(257 + 47);
    expect(encoded[0]).toBe(TlvTag.PublicKey);
    expect(encoded[1]).toBe(255);
    expect(encoded[257]).toBe(TlvTag.PublicKey);
    expect(encoded[258]).toBe(45);
  });

  it('round-trips fragmented values', () => {
    const bigValue = Buffer.alloc(300, 0xBB);
    const encoded = tlvEncode({ [TlvTag.PublicKey]: bigValue });
    const decoded = tlvDecode(encoded);
    expect(decoded[TlvTag.PublicKey]).toEqual(bigValue);
  });

  it('encodes multiple tags', () => {
    const data = {
      [TlvTag.SeqNo]: Buffer.from([0x01]),
      [TlvTag.Method]: Buffer.from([0x00]),
    };
    const encoded = tlvEncode(data);
    const decoded = tlvDecode(encoded);
    expect(decoded[TlvTag.SeqNo]).toEqual(Buffer.from([0x01]));
    expect(decoded[TlvTag.Method]).toEqual(Buffer.from([0x00]));
  });
});
