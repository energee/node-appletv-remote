/** Tests that the package entry exposes the classes a caller needs without deep imports. */
import { describe, expect, it } from 'vitest';
import * as entry from '../index.js';
import { PairSetup } from '../auth/pair-setup.js';

describe('package entry', () => {
  it('exports PairSetup for HAP pair-setup', () => {
    expect((entry as Record<string, unknown>).PairSetup).toBe(PairSetup);
  });
});
