/** Exercise the compiled executable, including npm-style bin symlinks, without device I/O. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let directory: string;
let executable: string;
beforeAll(() => {
  const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { encoding: 'utf8' });
  expect(build.status, build.stderr || build.stdout).toBe(0);
  const scratch = process.env.ATV_TEST_TMPDIR ?? resolve('node_modules/.cache');
  mkdirSync(scratch, { recursive: true });
  directory = mkdtempSync(join(scratch, 'cli-bin-'));
  executable = join(directory, 'atv');
  symlinkSync(resolve('dist/cli/index.js'), executable);
}, 30000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

it('runs help through an npm-style symlink', () => {
  const result = spawnSync(process.execPath, [executable, '--help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('atv seek');
});
it.each([['seek', 'invalid'], ['text', 'set'], ['command', 'constructor']])('reports invalid %s through an npm-style symlink', (...args) => {
  const result = spawnSync(process.execPath, [executable, ...args], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^Error:/);
  expect(result.stdout).not.toContain('Connecting');
});
