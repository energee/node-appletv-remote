/** Bounded DMAP tagged binary codec for login, pairing and play-status responses. */
export interface DmapFields { [tag: string]: number | bigint | string | Buffer | DmapFields }
const containers = new Set(['mlog', 'cmst', 'cmpa']);
const strings = new Set(['cann', 'cana', 'canl', 'cang', 'cmnm', 'cmty', 'cmbe']);
const widths: Record<string, number> = { mstt: 4, mlid: 4, cmsr: 4, caps: 1, cast: 4, cant: 4, cash: 1, carp: 1, cavc: 1, cmcc: 1, cmpg: 8 };

/** Encode a four-character tag with an explicit raw payload or UTF-8 string. */
export function encodeDmap(tag: string, value: Buffer | string): Buffer {
  if (!/^[a-zA-Z0-9]{4}$/.test(tag)) throw new Error('Invalid DMAP tag');
  const body = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const header = Buffer.alloc(8); header.write(tag, 'ascii'); header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Decode only known scalar/container types; unknown tags remain raw bytes. */
export function decodeDmap(data: Buffer, depth = 0): DmapFields {
  if (depth > 32) throw new Error('DMAP depth limit exceeded');
  if (data.length > 8 * 1024 * 1024) throw new Error('DMAP size limit exceeded');
  const fields: DmapFields = {};
  for (let offset = 0; offset < data.length;) {
    if (data.length - offset < 8) throw new Error('Truncated DMAP header');
    const tag = data.toString('ascii', offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    offset += 8;
    if (length > data.length - offset) throw new Error('Truncated DMAP payload');
    if (Object.hasOwn(fields, tag)) throw new Error(`Duplicate DMAP tag ${tag}`);
    const body = data.subarray(offset, offset + length); offset += length;
    if (containers.has(tag)) fields[tag] = decodeDmap(body, depth + 1);
    else if (strings.has(tag)) fields[tag] = body.toString('utf8');
    else if (Object.hasOwn(widths, tag)) {
      if (length !== widths[tag]) throw new Error(`Invalid DMAP integer width for ${tag}`);
      fields[tag] = length === 8 ? body.readBigUInt64BE() : body.readUIntBE(0, length);
    } else Object.defineProperty(fields, tag, { value: Buffer.from(body), enumerable: true });
  }
  return fields;
}
