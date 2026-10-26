/**
 * Guards the test environment: the CLI resolves ~/.atv-storage.json from HOME at import, and a
 * CLI test once saved a fake DMAP record into the developer's real storage file.
 */
import { describe, expect, it } from 'vitest';
import { homedir, tmpdir, userInfo } from 'node:os';

describe('test isolation', () => {
  it('points HOME at a temporary directory, never the real home', () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });
});
