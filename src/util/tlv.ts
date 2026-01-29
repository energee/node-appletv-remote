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

export type TlvData = Partial<Record<number, Buffer>>;

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
