import { describe, it, expect } from 'vitest';
import bplistCreator from 'bplist-creator';
import { encodeVarint, decodeVarint, buildDataStreamFrame, parseDataStreamFrame } from '../data-stream.js';

describe('varint encoding', () => {
  it('encodes and decodes single-byte values', () => {
    for (const val of [0, 1, 42, 127]) {
      const encoded = encodeVarint(val);
      const { value, bytesRead } = decodeVarint(encoded);
      expect(value).toBe(val);
      expect(bytesRead).toBe(1);
    }
  });

  it('encodes and decodes multi-byte values', () => {
    for (const val of [128, 300, 16384, 65535, 100000]) {
      const encoded = encodeVarint(val);
      const { value } = decodeVarint(encoded);
      expect(value).toBe(val);
      expect(encoded.length).toBeGreaterThan(1);
    }
  });

  it('round-trips a range of values', () => {
    for (let i = 0; i < 1000; i++) {
      const val = Math.floor(Math.random() * 0xfffffff);
      const encoded = encodeVarint(val);
      const { value } = decodeVarint(encoded);
      expect(value).toBe(val);
    }
  });
});

describe('DataStream framing', () => {
  /** A frame whose `params.data` is exactly `data`, for payloads the builder never produces. */
  function frameWithData(data: Buffer): Buffer {
    const plist = bplistCreator({ params: { data } });
    const header = buildDataStreamFrame().subarray(0, 32);
    header.writeUInt32BE(32 + plist.length);
    return Buffer.concat([header, plist]);
  }

  it('preserves every protobuf in a batch, in order', () => {
    const messages = [Buffer.from([8, 15]), Buffer.from([8, 17]), Buffer.from([8, 4])];
    expect(parseDataStreamFrame(buildDataStreamFrame(...messages))?.protobufMessages).toEqual(messages);
  });

  it.each([
    ['a zero-length entry', [2, 8, 15, 0, 0, 0], [[8, 15]]],
    ['an unterminated length varint', [2, 8, 15, 0x81], [[8, 15]]],
    ['an entry longer than the payload', [2, 8, 15, 5, 8, 1], [[8, 15]]],
    ['a length prefix over 4 bytes', [2, 8, 15, 0x80, 0x80, 0x80, 0x80, 0x80, 1], [[8, 15]]],
    ['an entry not starting with the type tag', [2, 8, 15, 1, 0x12], [[8, 15]]],
    ['an unprefixed message after a prefixed one', [2, 8, 15, 8, 4, 0x12, 0], [[8, 15], [8, 4, 0x12, 0]]],
    ['an empty payload', [], []],
  ])('splits a payload with %s', (_, data, expected) => {
    const frame = parseDataStreamFrame(frameWithData(Buffer.from(data)));
    expect(frame?.protobufMessages).toEqual(expected.map(bytes => Buffer.from(bytes)));
  });

  it('builds a frame with a 32-byte header', () => {
    const data = Buffer.from([0x08, 0x01]); // minimal protobuf
    const frame = buildDataStreamFrame(data);
    expect(frame.length).toBeGreaterThan(32);
    // First 4 bytes are total size (big-endian)
    const totalSize = frame.readUInt32BE(0);
    expect(totalSize).toBe(frame.length);
  });

  it('contains "sync" message type in header', () => {
    const frame = buildDataStreamFrame(Buffer.from([0x08, 0x01]));
    const msgType = frame.subarray(4, 8).toString('ascii');
    expect(msgType).toBe('sync');
  });

  it('contains "comm" command in header', () => {
    const frame = buildDataStreamFrame(Buffer.from([0x08, 0x01]));
    const command = frame.subarray(16, 20).toString('ascii');
    expect(command).toBe('comm');
  });
});

it.each([0, 1, 31])('rejects totalSize %s smaller than its DataStream header', (size) => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(size);
  expect(() => parseDataStreamFrame(bytes)).toThrow(/size|header/i);
});
