/**
 * TLV8 encoding used by HAP pair-setup and pair-verify messages:
 * 1-byte tag, 1-byte length, value, with values over 255 bytes split into consecutive fragments.
 */

/** HAP TLV8 tag numbers. */
export enum TlvTag {
  Method = 0x00,
  Identifier = 0x01,
  Salt = 0x02,
  PublicKey = 0x03,
  Proof = 0x04,
  EncryptedData = 0x05,
  SeqNo = 0x06,
  Error = 0x07,
  BackOff = 0x08,
  Certificate = 0x09,
  Signature = 0x0a,
  Permissions = 0x0b,
  FragmentData = 0x0c,
  FragmentLast = 0x0d,
  Name = 0x11,
  Flags = 0x13,
}

/** Decoded/encodable TLV map keyed by numeric tag (use `TlvTag` values). */
export type TlvData = Partial<Record<number, Buffer>>;

/**
 * Encode a tag map as TLV8. Values longer than 255 bytes are split into 255-byte fragments
 * with the same tag; an empty Buffer encodes as a zero-length item; undefined values are skipped.
 * Tags are emitted in ascending numeric order (JS integer-key ordering), not insertion order.
 */
export function tlvEncode(data: TlvData): Buffer {
  const parts: Buffer[] = [];
  for (const [tagStr, value] of Object.entries(data)) {
    const tag = Number(tagStr);
    if (!value) continue;
    let offset = 0;
    while (offset < value.length) {
      const chunkSize = Math.min(255, value.length - offset);
      const header = Buffer.from([tag, chunkSize]);
      parts.push(header, value.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    }
    if (value.length === 0) {
      parts.push(Buffer.from([tag, 0]));
    }
  }
  return Buffer.concat(parts);
}

/**
 * Decode TLV8 into a tag map, concatenating repeated items with the same tag (reassembling
 * fragmented values). Does not validate lengths: a truncated item yields a short value.
 */
export function tlvDecode(buf: Buffer): TlvData {
  const result: TlvData = {};
  let offset = 0;
  while (offset < buf.length) {
    const tag = buf[offset];
    const length = buf[offset + 1];
    const value = buf.subarray(offset + 2, offset + 2 + length);
    if (result[tag]) {
      result[tag] = Buffer.concat([result[tag]!, value]);
    } else {
      result[tag] = Buffer.from(value);
    }
    offset += 2 + length;
  }
  return result;
}
