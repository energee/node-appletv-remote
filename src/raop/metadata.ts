/** Finite local-file tags and bounded, structurally identified embedded JPEG artwork. */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { parseFile } from 'music-metadata';
import type { RaopMetadata } from './stream.js';

const MAX_ARTWORK_BYTES = 1024 * 1024;
const MAX_PICTURE_BYTES = MAX_ARTWORK_BYTES + 65536;
const MAX_COMMENT_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 4096;

export interface ExtractedRaopMetadata {
  metadata: RaopMetadata;
  duration?: number;
}

/** Every allocation is checked against both the containing structure and a fixed metadata bound. */
async function readAt(file: FileHandle, offset: number, length: number, end: number): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      length > MAX_COMMENT_BYTES || offset > end - length) return undefined;
  const buffer = Buffer.allocUnsafe(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await file.read(buffer, consumed, length - consumed, offset + consumed);
    if (!bytesRead) return undefined;
    consumed += bytesRead;
  }
  return buffer;
}

function jpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes.length <= MAX_ARTWORK_BYTES && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** FLAC PICTURE is also the payload of Vorbis/Opus METADATA_BLOCK_PICTURE. */
function pictureBlock(block: Buffer): Buffer | undefined {
  if (block.length < 32) return undefined;
  const mimeEnd = 8 + block.readUInt32BE(4);
  if (mimeEnd > block.length - 24 || block.toString('ascii', 8, mimeEnd).toLowerCase() !== 'image/jpeg') return undefined;
  const imageStart = mimeEnd + 24 + block.readUInt32BE(mimeEnd);
  if (imageStart > block.length || block.readUInt32BE(imageStart - 4) !== block.length - imageStart) return undefined;
  const image = block.subarray(imageStart);
  return jpeg(image) ? Buffer.from(image) : undefined;
}

function syncsafe(bytes: Buffer, offset: number): number | undefined {
  if (offset > bytes.length - 4 || bytes.subarray(offset, offset + 4).some(byte => byte > 127)) return undefined;
  return bytes[offset] * 0x200000 + bytes[offset + 1] * 0x4000 + bytes[offset + 2] * 0x80 + bytes[offset + 3];
}

async function id3Artwork(file: FileHandle, start: number, end: number): Promise<Buffer | undefined> {
  const header = await readAt(file, start, 10, end);
  if (!header || header.toString('ascii', 0, 3) !== 'ID3' || ![3, 4].includes(header[3]) || (header[5] & 0x80)) return undefined;
  const size = syncsafe(header, 6);
  if (size === undefined || start + 10 + size > end) return undefined;
  const tagEnd = start + 10 + size;
  let offset = start + 10;
  if (header[5] & 0x40) {
    const extended = await readAt(file, offset, 4, tagEnd);
    if (!extended) return undefined;
    const length = header[3] === 4 ? syncsafe(extended, 0) : extended.readUInt32BE(0) + 4;
    if (length === undefined || length < 4 || offset > tagEnd - length) return undefined;
    offset += length;
  }
  for (let count = 0; count < MAX_RECORDS && offset <= tagEnd - 10; count++) {
    const frameHeader = await readAt(file, offset, 10, tagEnd);
    if (!frameHeader) return undefined;
    const name = frameHeader.toString('ascii', 0, 4);
    const length = header[3] === 4 ? syncsafe(frameHeader, 4) : frameHeader.readUInt32BE(4);
    offset += 10;
    if (!/^[A-Z0-9]{4}$/.test(name) || length === undefined || offset > tagEnd - length) return undefined;
    // Skip compressed/encrypted/grouped/unsynchronised picture frames rather than treating their bytes as JPEG.
    if (name === 'APIC' && (frameHeader[9] === 0 || header[3] === 4 && frameHeader[9] === 1) && length <= MAX_PICTURE_BYTES) {
      let frame = await readAt(file, offset, length, tagEnd);
      if (!frame) return undefined;
      if (frameHeader[9] === 1) {
        if (syncsafe(frame, 0) !== frame.length - 4) return undefined;
        frame = frame.subarray(4);
      }
      if (frame.length < 4 || frame[0] > 3) return undefined;
      const mimeEnd = frame.indexOf(0, 1);
      if (mimeEnd > 1 && frame.toString('ascii', 1, mimeEnd).toLowerCase() === 'image/jpeg') {
        const wide = frame[0] === 1 || frame[0] === 2;
        let imageStart = mimeEnd + 2;
        while (imageStart < frame.length && (wide
          ? imageStart + 1 >= frame.length || frame[imageStart] !== 0 || frame[imageStart + 1] !== 0
          : frame[imageStart] !== 0)) imageStart += wide ? 2 : 1;
        imageStart += wide ? 2 : 1;
        const image = frame.subarray(imageStart);
        if (jpeg(image)) return Buffer.from(image);
      }
    }
    offset += length;
  }
  return undefined;
}

async function flacArtwork(file: FileHandle, end: number): Promise<Buffer | undefined> {
  let offset = 4;
  for (let count = 0; count < MAX_RECORDS; count++) {
    const header = await readAt(file, offset, 4, end);
    if (!header) return undefined;
    const length = header.readUIntBE(1, 3);
    offset += 4;
    if (offset > end - length) return undefined;
    if ((header[0] & 0x7f) === 6 && length <= MAX_PICTURE_BYTES) {
      const block = await readAt(file, offset, length, end);
      const image = block && pictureBlock(block);
      if (image) return image;
    }
    if (header[0] & 0x80) return undefined;
    offset += length;
  }
  return undefined;
}

/** Walk only metadata atoms, never search mdat or arbitrary media bytes for image signatures. */
async function mp4Artwork(file: FileHandle, start: number, end: number, depth: number,
  cover: boolean, budget: { remaining: number }): Promise<Buffer | undefined> {
  if (depth > 8) return undefined;
  for (let offset = start; offset <= end - 8 && budget.remaining-- > 0;) {
    const header = await readAt(file, offset, 8, end);
    if (!header) return undefined;
    let length = header.readUInt32BE(0);
    let headerLength = 8;
    if (length === 1) {
      const extended = await readAt(file, offset + 8, 8, end);
      if (!extended) return undefined;
      const wide = extended.readBigUInt64BE();
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      length = Number(wide); headerLength = 16;
    } else if (length === 0) length = end - offset;
    if (length < headerLength || offset > end - length) return undefined;
    const name = header.toString('latin1', 4, 8);
    const payload = offset + headerLength;
    const atomEnd = offset + length;
    if (cover && name === 'data' && atomEnd - payload >= 8) {
      const dataHeader = await readAt(file, payload, 8, atomEnd);
      if (dataHeader && (dataHeader.readUInt32BE(0) & 0xffffff) === 13 && atomEnd - payload - 8 <= MAX_ARTWORK_BYTES) {
        const image = await readAt(file, payload + 8, atomEnd - payload - 8, atomEnd);
        if (image && jpeg(image)) return image;
      }
    } else if (['moov', 'udta', 'meta', 'ilst', 'covr'].includes(name)) {
      const image = await mp4Artwork(file, payload + (name === 'meta' ? 4 : 0), atomEnd, depth + 1, name === 'covr', budget);
      if (image) return image;
    }
    offset = atomEnd;
  }
  return undefined;
}

async function wavArtwork(file: FileHandle, end: number): Promise<Buffer | undefined> {
  const riff = await readAt(file, 0, 12, end);
  if (!riff || riff.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  const riffEnd = 8 + riff.readUInt32LE(4);
  if (riffEnd > end || riffEnd < 12) return undefined;
  for (let offset = 12, count = 0; offset <= riffEnd - 8 && count < MAX_RECORDS; count++) {
    const chunk = await readAt(file, offset, 8, riffEnd);
    if (!chunk) return undefined;
    const length = chunk.readUInt32LE(4);
    const payload = offset + 8;
    if (payload > riffEnd - length) return undefined;
    if (chunk.toString('ascii', 0, 4).toLowerCase() === 'id3 ') {
      const image = await id3Artwork(file, payload, payload + length);
      if (image) return image;
    }
    offset = payload + length + (length % 2);
  }
  return undefined;
}

function commentArtwork(packet: Buffer, start: number): Buffer | undefined {
  if (start > packet.length - 4) return undefined;
  let offset = start + 4 + packet.readUInt32LE(start);
  if (offset > packet.length - 4) return undefined;
  const count = packet.readUInt32LE(offset); offset += 4;
  if (count > MAX_RECORDS) return undefined;
  for (let index = 0; index < count; index++) {
    if (offset > packet.length - 4) return undefined;
    const length = packet.readUInt32LE(offset); offset += 4;
    if (offset > packet.length - length) return undefined;
    const entry = packet.subarray(offset, offset + length); offset += length;
    const separator = entry.indexOf(61);
    if (separator < 0 || entry.toString('ascii', 0, separator).toUpperCase() !== 'METADATA_BLOCK_PICTURE') continue;
    const encoded = entry.subarray(separator + 1);
    if (encoded.length > Math.ceil(MAX_PICTURE_BYTES / 3) * 4) continue;
    const text = encoded.toString('ascii');
    if (text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) continue;
    const image = pictureBlock(Buffer.from(text, 'base64'));
    if (image) return image;
  }
  return undefined;
}

/** Assemble bounded Ogg header packets with lacing; comments cannot be found in arbitrary audio bytes. */
async function oggArtwork(file: FileHandle, end: number): Promise<Buffer | undefined> {
  let offset = 0; let serial: number | undefined; let sequence: number | undefined;
  let identification: 'vorbis' | 'opus' | undefined;
  let chunks: Buffer[] = []; let packetBytes = 0;
  for (let page = 0; page < 128; page++) {
    const header = await readAt(file, offset, 27, end);
    if (!header || header.toString('ascii', 0, 4) !== 'OggS' || header[4] !== 0) return undefined;
    const pageSerial = header.readUInt32LE(14);
    const laces = await readAt(file, offset + 27, header[26], end);
    if (!laces) return undefined;
    const length = laces.reduce((total, byte) => total + byte, 0);
    const payloadStart = offset + 27 + laces.length;
    if (payloadStart > end - length) return undefined;
    offset = payloadStart + length;
    if (serial === undefined) {
      // Skeleton and other BOS streams can precede audio. Pin only a declared audio identification packet.
      if (!(header[5] & 2) || header[5] & 1) continue;
      const prefix = await readAt(file, payloadStart, Math.min(length, 8), end);
      if (!prefix || !(prefix[0] === 1 && prefix.toString('ascii', 1, 7) === 'vorbis') &&
          prefix.toString('ascii', 0, 8) !== 'OpusHead') continue;
      serial = pageSerial;
    }
    if (pageSerial !== serial) continue;
    const nextSequence = header.readUInt32LE(18);
    if ((sequence !== undefined && nextSequence !== ((sequence + 1) >>> 0)) ||
        Boolean(header[5] & 1) !== (packetBytes > 0)) return undefined;
    sequence = nextSequence;
    const payload = await readAt(file, payloadStart, length, end);
    if (!payload) return undefined;
    let position = 0;
    for (const lace of laces) {
      if (packetBytes + lace > MAX_COMMENT_BYTES) return undefined;
      chunks.push(payload.subarray(position, position + lace)); packetBytes += lace; position += lace;
      if (lace === 255) continue;
      const packet = Buffer.concat(chunks, packetBytes); chunks = []; packetBytes = 0;
      if (!identification) {
        if (packet[0] === 1 && packet.toString('ascii', 1, 7) === 'vorbis') identification = 'vorbis';
        else if (packet.toString('ascii', 0, 8) === 'OpusHead') identification = 'opus';
        else return undefined;
      } else if (identification === 'vorbis' && packet[0] === 3 && packet.toString('ascii', 1, 7) === 'vorbis') return commentArtwork(packet, 7);
      else if (identification === 'opus' && packet.toString('ascii', 0, 8) === 'OpusTags') return commentArtwork(packet, 8);
      else return undefined;
    }
  }
  return undefined;
}

async function embeddedArtwork(path: string): Promise<Buffer | undefined> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    const size = stat.size;
    if (!stat.isFile() || !Number.isSafeInteger(size)) return undefined;
    const header = await readAt(file, 0, Math.min(size, 12), size);
    if (!header) return undefined;
    if (header.toString('ascii', 0, 3) === 'ID3') return await id3Artwork(file, 0, size);
    if (header.toString('ascii', 0, 4) === 'fLaC') return await flacArtwork(file, size);
    if (header.toString('ascii', 0, 4) === 'RIFF') return await wavArtwork(file, size);
    if (header.toString('ascii', 0, 4) === 'OggS') return await oggArtwork(file, size);
    if (header.toString('ascii', 4, 8) === 'ftyp') return await mp4Artwork(file, 0, size, 0, false, { remaining: MAX_RECORDS });
    return undefined;
  } finally { await file.close(); }
}

/** Extract finite-file tags; explicit caller fields win. Unsupported/non-JPEG covers are omitted, never relabeled. */
export async function extractRaopMetadata(file: string, explicit: RaopMetadata = {}): Promise<ExtractedRaopMetadata> {
  const parsed = await parseFile(file, { skipCovers: true });
  const artwork = explicit.artwork === undefined ? await embeddedArtwork(file) : undefined;
  const metadata: RaopMetadata = {
    ...(parsed.common.title === undefined ? {} : { title: parsed.common.title }),
    ...(parsed.common.artist === undefined ? {} : { artist: parsed.common.artist }),
    ...(parsed.common.album === undefined ? {} : { album: parsed.common.album }),
    ...(artwork === undefined ? {} : { artwork }),
    ...explicit,
  };
  return { metadata,
    ...(Number.isFinite(parsed.format.duration) && parsed.format.duration! >= 0 ? { duration: parsed.format.duration } : {}) };
}
