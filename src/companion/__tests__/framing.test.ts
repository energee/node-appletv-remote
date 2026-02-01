import { describe, it, expect } from 'vitest';
import { encodeFrame, parseFrames, FrameType } from '../framing.js';

describe('Companion Framing', () => {
  it('encodes a frame with type and payload', () => {
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    const frame = encodeFrame(FrameType.E_OPACK, payload);
    expect(frame[0]).toBe(0x08); // E_OPACK
    expect(frame[1]).toBe(0);    // length high byte
    expect(frame[2]).toBe(0);    // length mid byte
    expect(frame[3]).toBe(3);    // length low byte
    expect(frame.subarray(4)).toEqual(payload);
  });

  it('encodes frame with large payload length', () => {
    const payload = Buffer.alloc(0x010203);
    const frame = encodeFrame(FrameType.PS_Start, payload);
    expect(frame[0]).toBe(0x03);
    expect(frame[1]).toBe(0x01);
    expect(frame[2]).toBe(0x02);
    expect(frame[3]).toBe(0x03);
  });

  it('parses a single complete frame', () => {
    const payload = Buffer.from('hello');
    const raw = encodeFrame(FrameType.PV_Start, payload);
    const { frames, remainder } = parseFrames(raw);
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe(FrameType.PV_Start);
    expect(frames[0].payload).toEqual(payload);
    expect(remainder.length).toBe(0);
  });

  it('parses multiple frames', () => {
    const f1 = encodeFrame(FrameType.PS_Start, Buffer.from([0xaa]));
    const f2 = encodeFrame(FrameType.PS_Next, Buffer.from([0xbb, 0xcc]));
    const raw = Buffer.concat([f1, f2]);
    const { frames, remainder } = parseFrames(raw);
    expect(frames.length).toBe(2);
    expect(frames[0].type).toBe(FrameType.PS_Start);
    expect(frames[1].type).toBe(FrameType.PS_Next);
    expect(remainder.length).toBe(0);
  });

  it('returns remainder for incomplete frames', () => {
    const complete = encodeFrame(FrameType.E_OPACK, Buffer.from([1, 2]));
    const partial = Buffer.from([0x08, 0x00, 0x00, 0x05, 0x01]); // expects 5 bytes, has 1
    const raw = Buffer.concat([complete, partial]);
    const { frames, remainder } = parseFrames(raw);
    expect(frames.length).toBe(1);
    expect(remainder).toEqual(partial);
  });

  it('returns entire buffer as remainder when header incomplete', () => {
    const raw = Buffer.from([0x08, 0x00]);
    const { frames, remainder } = parseFrames(raw);
    expect(frames.length).toBe(0);
    expect(remainder).toEqual(raw);
  });

  it('handles empty buffer', () => {
    const { frames, remainder } = parseFrames(Buffer.alloc(0));
    expect(frames.length).toBe(0);
    expect(remainder.length).toBe(0);
  });
});
