/** Independent wire fixtures for the legacy PCM RAOP transport. */
import { describe, expect, it } from 'vitest';

const load = () => import('../packets.js');

describe('RAOP packets', () => {
  it('encodes little-endian PCM as big-endian L16 without mutating input', async () => {
    const module = await load();
    expect(module?.audioPacket).toBeTypeOf('function');
    const pcm = Buffer.from('01000200feff0080', 'hex');
    const packet = module!.audioPacket(pcm, 65535, 0xfffffff0, 0x12345678, true);
    expect(packet.subarray(0, 20).toString('hex')).toBe('80e0fffffffffff01234567800010002fffe8000');
    expect(packet.length).toBe(1420);
    expect(pcm.toString('hex')).toBe('01000200feff0080');
    expect(packet.subarray(20).every(byte => byte === 0)).toBe(true);
  });

  it('wraps sequence and RTP counters and rejects incomplete stereo frames', async () => {
    const module = await load();
    expect(module?.audioPacket).toBeTypeOf('function');
    expect(module!.audioPacket(Buffer.alloc(4), 65536, 0x100000150, 1, false).subarray(0, 12).toString('hex')).toBe('806000000000015000000001');
    expect(() => module!.audioPacket(Buffer.alloc(3), 0, 0, 0, false)).toThrow();
    expect(() => module!.audioPacket(Buffer.alloc(1412), 0, 0, 0, false)).toThrow();
  });

  it('answers timing with echoed originate and distinct receive/send timestamps', async () => {
    const module = await load();
    expect(module?.timingReply).toBeTypeOf('function');
    const request = Buffer.from('80d200010000000000000000000000000000000000000000123456789abcdef0', 'hex');
    expect(module!.timingReply(request, 0, 500)?.toString('hex')).toBe('80d3000700000000123456789abcdef083aa7e800000000083aa7e8080000000');
    expect(module!.timingReply(Buffer.alloc(3), 0, 0)).toBeUndefined();
    expect(module!.timingReply(Buffer.alloc(32), 0, 0)).toBeUndefined();
  });

  it('answers timing requests regardless of the version byte and echoes it', async () => {
    const module = await load();
    const request = Buffer.from('00d200010000000000000000000000000000000000000000123456789abcdef0', 'hex');
    expect(module!.timingReply(request, 0, 500)?.subarray(0, 2).toString('hex')).toBe('00d3');
  });

  it('encodes sync latency subtraction modulo 32 bits', async () => {
    const module = await load();
    expect(module?.syncPacket).toBeTypeOf('function');
    expect(module!.syncPacket(10, 20, 500, true).toString('hex')).toBe('90d40007fffffff683aa7e80800000000000000a');
  });

  it('resends exact original packets across rollover and evicts old history', async () => {
    const module = await load();
    expect(module?.PacketHistory).toBeTypeOf('function');
    const history = new module!.PacketHistory(2);
    const a = Buffer.from('8060ffff0000000100000001', 'hex');
    const b = Buffer.from('806000000000000200000001', 'hex');
    history.add(a); history.add(b);
    const request = Buffer.from('80d50001ffff0002', 'hex');
    expect(history.resend(request).map(packet => packet.toString('hex'))).toEqual([
      '80d6ffff8060ffff0000000100000001', '80d60000806000000000000200000001',
    ]);
    history.add(Buffer.from('806000010000000300000001', 'hex'));
    expect(history.resend(request)).toHaveLength(1);
    expect(history.resend(Buffer.alloc(7))).toEqual([]);
    expect(history.resend(Buffer.from('80d500010000ffff', 'hex'))).toEqual([]);
    history.clear();
    expect(history.resend(request)).toEqual([]);
  });
});

it('rejects requests above the remaining resend budget before producing copies', async () => {
  const module = await load(); const history = new module.PacketHistory();
  history.add(Buffer.from('806000000000000000000000', 'hex'));
  expect(history.resend(Buffer.from('80d5000100000001', 'hex'), 0)).toEqual([]);
  expect(history.resend(Buffer.from('80d5000100000002', 'hex'), 1)).toEqual([]);
  expect(history.resend(Buffer.from('80d5000100000001', 'hex'), 1)).toHaveLength(1);
});

it('rejects large retransmission bursts despite available history', async () => {
  const module = await load(); const history = new module.PacketHistory();
  history.add(Buffer.from('806000000000000000000000', 'hex'));
  expect(history.resend(Buffer.from('80d5000100000065', 'hex'))).toEqual([]);
});
