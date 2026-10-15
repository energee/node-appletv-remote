/**
 * Minimal RIFF/WAVE reader for RaopStream: accepts only PCM16 stereo 44.1 kHz files and yields
 * the raw `data` payload as a RaopPcmSource-compatible async Buffer source. No transcoding.
 */
import type { Readable } from 'node:stream';

const MAX_CHUNK = 65536;
const UNSUPPORTED = 'Unsupported WAV: requires PCM16 stereo 44100 Hz';

/**
 * Validate the WAV header and yield the `data` chunk in Buffers of at most 65,536 bytes.
 * Non-`fmt ` chunks before `data` are skipped (including RIFF odd-size pad bytes); reading stops
 * at the declared data length. A non-PCM16/stereo/44.1 kHz `fmt ` throws the Unsupported error;
 * a malformed header, `data` before `fmt `, or a source ending before the declared data length
 * throws an `Invalid WAV` error. The source is destroyed when iteration ends for any reason.
 */
export async function* wavPcm(source: Readable): AsyncIterable<Buffer> {
  const input: AsyncIterator<unknown> = source[Symbol.asyncIterator]();
  let buffered: Buffer = Buffer.alloc(0);
  const fill = async () => {
    const next = await input.next();
    if (next.done) throw new Error('Invalid WAV: truncated');
    if (!Buffer.isBuffer(next.value)) throw new Error('Invalid WAV: source must yield Buffers');
    buffered = buffered.length ? Buffer.concat([buffered, next.value]) : next.value;
  };
  // Exactly `bytes` from the stream (header-sized reads only).
  const take = async (bytes: number) => {
    while (buffered.length < bytes) await fill();
    const out = buffered.subarray(0, bytes); buffered = buffered.subarray(bytes);
    return out;
  };
  // Up to `bytes` (and at most MAX_CHUNK) without concatenating; used for skipping and data.
  const some = async (bytes: number) => {
    while (!buffered.length) await fill();
    return take(Math.min(bytes, buffered.length, MAX_CHUNK));
  };
  try {
    const riff = await take(12);
    if (riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Invalid WAV: missing RIFF/WAVE header');
    let haveFormat = false;
    for (;;) {
      const header = await take(8);
      const id = header.toString('latin1', 0, 4); let size = header.readUInt32LE(4);
      if (id === 'data') {
        if (!haveFormat) throw new Error('Invalid WAV: data chunk before fmt chunk');
        while (size > 0) { const piece = await some(size); size -= piece.length; yield piece; }
        return;
      }
      if (id === 'fmt ') {
        if (size < 16 || size > 1024) throw new Error('Invalid WAV: malformed fmt chunk');
        const format = await take(size);
        if (format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 2 || format.readUInt32LE(4) !== 44100 || format.readUInt16LE(14) !== 16) throw new Error(UNSUPPORTED);
        haveFormat = true; size = 0;
      }
      size += header.readUInt32LE(4) % 2; // RIFF pads odd-sized chunks to an even length
      while (size > 0) size -= (await some(size)).length;
    }
  } finally {
    source.destroy();
  }
}
