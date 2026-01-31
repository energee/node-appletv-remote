import { describe, it, expect } from 'vitest';
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
