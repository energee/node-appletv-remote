/** Regression tests for four decoding/resource bugs found during the documentation audit. */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decodeVarint } from '../util/data-stream.js';
import { tlvDecode } from '../util/tlv.js';
import { encodeFrame, FrameType } from '../companion/framing.js';
import { PairVerify } from '../auth/pair-verify.js';

describe('decodeVarint', () => {
  it('decodes values at and above 2^31 without 32-bit overflow', () => {
    // 2^31 = varint 80 80 80 80 08; 2^35 = 80 80 80 80 80 01
    expect(decodeVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x08])).value).toBe(2 ** 31);
    expect(decodeVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])).value).toBe(2 ** 35);
  });
});

describe('tlvDecode', () => {
  it('throws on a truncated item instead of returning a short value', () => {
    expect(() => tlvDecode(Buffer.from([0x03, 0x05, 0xaa, 0xbb]))).toThrow(/truncated/i);
    expect(() => tlvDecode(Buffer.from([0x03]))).toThrow(/truncated/i);
  });
});

describe('encodeFrame', () => {
  it('rejects payloads that do not fit the 3-byte length field', () => {
    expect(() => encodeFrame(FrameType.E_OPACK, Buffer.alloc(0x1000000))).toThrow(RangeError);
  });
});

describe('PairVerify.verify', () => {
  it('closes its HTTP connection when the handshake fails', async () => {
    const pv = new PairVerify('127.0.0.1', 7000, {
      clientId: 'id', clientLTSK: randomBytes(32), clientLTPK: randomBytes(32),
      serverLTPK: randomBytes(32), serverId: 's',
    });
    const http = (pv as unknown as { http: { post: unknown; destroy: () => void } }).http;
    http.post = vi.fn().mockResolvedValue(Buffer.alloc(0)); // M2 missing fields → throws
    const destroy = vi.spyOn(http, 'destroy');
    await expect(pv.verify()).rejects.toThrow(/M2 missing/);
    expect(destroy).toHaveBeenCalled();
  });
});
