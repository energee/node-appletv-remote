/** Tests that the package entry exposes the classes a caller needs without deep imports. */
import { describe, expect, it } from 'vitest';
import * as entry from '../index.js';
import { PairSetup } from '../auth/pair-setup.js';

describe('package entry', () => {
  it('exports PairSetup for HAP pair-setup', () => {
    expect((entry as Record<string, unknown>).PairSetup).toBe(PairSetup);
  });
});

describe('pyatv-parity exports', () => {
  it('exports ShuffleState, RepeatState and PowerState', async () => {
    const lib = await import('../index.js');
    expect(lib.ShuffleState.Songs).toBe(3);
    expect(lib.RepeatState.All).toBe(2);
    expect(lib.PowerState.On).toBe('on');
  });
});
