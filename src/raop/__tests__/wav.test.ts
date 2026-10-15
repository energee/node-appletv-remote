/** WAV reader fixtures: hand-built RIFF headers fed through Readables of various chunkings. */
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

const load = () => import('../wav.js');
const UNSUPPORTED = 'Unsupported WAV: requires PCM16 stereo 44100 Hz';

const chunk = (id: string, body: Buffer) => {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const fmt = ({ format = 1, channels = 2, rate = 44100, bits = 16 } = {}) => {
  const body = Buffer.alloc(16);
  body.writeUInt16LE(format, 0); body.writeUInt16LE(channels, 2); body.writeUInt32LE(rate, 4);
  body.writeUInt32LE(rate * channels * bits / 8, 8); body.writeUInt16LE(channels * bits / 8, 12); body.writeUInt16LE(bits, 14);
  return chunk('fmt ', body);
};
const wav = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};
const pcm = (bytes: number) => Buffer.from(Array.from({ length: bytes }, (_, index) => (index * 7) & 0xff));
const pieces = (buffer: Buffer, size: number) => {
  const out: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) out.push(buffer.subarray(offset, offset + size));
  return out;
};
const collect = async (iterable: AsyncIterable<Buffer>) => {
  const out: Buffer[] = [];
  for await (const value of iterable) out.push(value);
  return out;
};

describe('wavPcm', () => {
  it('skips a LIST chunk and yields the data payload exactly', async () => {
    const { wavPcm } = await load();
    const payload = pcm(4096);
    const out = await collect(wavPcm(Readable.from([wav(fmt(), chunk('LIST', Buffer.from('INFOtest')), chunk('data', payload))])));
    expect(Buffer.concat(out).equals(payload)).toBe(true);
  });

  it('parses a header split into one-byte reads', async () => {
    const { wavPcm } = await load();
    const payload = pcm(64);
    const out = await collect(wavPcm(Readable.from(pieces(wav(fmt(), chunk('LIST', Buffer.alloc(10)), chunk('data', payload)), 1))));
    expect(Buffer.concat(out).equals(payload)).toBe(true);
  });

  it('honors the pad byte after an odd-sized chunk', async () => {
    const { wavPcm } = await load();
    const payload = pcm(16);
    const out = await collect(wavPcm(Readable.from(pieces(wav(fmt(), chunk('junk', Buffer.from('odd')), chunk('data', payload)), 3))));
    expect(Buffer.concat(out).equals(payload)).toBe(true);
  });

  it('yields chunks of at most 65536 bytes and stops at the declared data length', async () => {
    const { wavPcm } = await load();
    const payload = pcm(200_000);
    const trailer = chunk('LIST', Buffer.alloc(32, 0xaa));
    const out = await collect(wavPcm(Readable.from(pieces(wav(fmt(), chunk('data', payload), trailer), 100_000))));
    expect(out.length).toBeGreaterThan(1);
    expect(out.every(value => value.length > 0 && value.length <= 65536)).toBe(true);
    expect(Buffer.concat(out).equals(payload)).toBe(true);
  });

  it.each([
    ['rate', { rate: 48000 }],
    ['channels', { channels: 1 }],
    ['format', { format: 3, bits: 32 }],
    ['bits', { bits: 24 }],
  ])('rejects an unsupported %s', async (_name, options) => {
    const { wavPcm } = await load();
    await expect(collect(wavPcm(Readable.from([wav(fmt(options), chunk('data', pcm(16)))])))).rejects.toThrow(UNSUPPORTED);
  });

  it('rejects a truncated header, a non-RIFF stream, and data before fmt', async () => {
    const { wavPcm } = await load();
    const truncated = wav(fmt(), chunk('data', pcm(16))).subarray(0, 30);
    await expect(collect(wavPcm(Readable.from([truncated])))).rejects.toThrow(/Invalid WAV/);
    await expect(collect(wavPcm(Readable.from([Buffer.from('not a wav file at all, honestly')])))).rejects.toThrow(/Invalid WAV/);
    await expect(collect(wavPcm(Readable.from([wav(chunk('data', pcm(16)), fmt())])))).rejects.toThrow(/Invalid WAV/);
  });

  it('rejects a source that ends inside the data chunk', async () => {
    const { wavPcm } = await load();
    const whole = wav(fmt(), chunk('data', pcm(64)));
    await expect(collect(wavPcm(Readable.from([whole.subarray(0, whole.length - 8)])))).rejects.toThrow(/Invalid WAV/);
  });

  it('destroys the source on validation failure and early consumer return', async () => {
    const { wavPcm } = await load();
    const bad = Readable.from([wav(fmt({ rate: 22050 }), chunk('data', pcm(16)))]);
    await expect(collect(wavPcm(bad))).rejects.toThrow(UNSUPPORTED);
    expect(bad.destroyed).toBe(true);
    const good = Readable.from(pieces(wav(fmt(), chunk('data', pcm(200_000))), 65536));
    for await (const value of wavPcm(good)) { expect(value.length).toBeGreaterThan(0); break; }
    expect(good.destroyed).toBe(true);
  });
});
