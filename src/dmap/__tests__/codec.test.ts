/** Independent DMAP wire fixtures and hostile length/depth cases. */
import { describe, expect, it } from 'vitest';
import { decodeDmap, encodeDmap } from '../codec.js';

describe('DMAP codec', () => {
  it('decodes a literal login response with an unsigned session ID', () => {
    expect(decodeDmap(Buffer.from('6d6c6f67000000186d73747400000004000000c86d6c696400000004f0000001', 'hex'))).toEqual({ mlog: { mstt: 200, mlid: 4026531841 } });
  });
  it('encodes Remote select without a container', () => {
    expect(Buffer.concat([encodeDmap('cmbe', 'select'), encodeDmap('cmcc', Buffer.from([0]))]).toString('hex')).toBe('636d62650000000673656c656374636d63630000000100');
  });
  it('preserves unknown payloads rather than guessing their type', () => {
    expect(decodeDmap(Buffer.from('78787878000000020102', 'hex'))).toEqual({ xxxx: Buffer.from([1, 2]) });
  });
  for (const hex of ['00', '6d6c6f6700000010', '6d6c696400000003000001', '6d6c6f67000000096d6c69640000000400']) {
    it(`rejects truncated or incorrectly sized tags: ${hex}`, () => expect(() => decodeDmap(Buffer.from(hex, 'hex'))).toThrow());
  }
  it('rejects deeply nested containers', () => {
    let data: Buffer = Buffer.alloc(0);
    for (let i = 0; i < 40; i++) data = encodeDmap('cmst', data);
    expect(() => decodeDmap(data)).toThrow(/depth/i);
  });
  it('rejects duplicate fields instead of silently overwriting', () => {
    expect(() => decodeDmap(Buffer.concat([encodeDmap('cann', 'one'), encodeDmap('cann', 'two')]))).toThrow(/duplicate/i);
  });
});
