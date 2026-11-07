/** Exercise the compiled executable, including npm-style bin symlinks, without device I/O. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

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
}, 60000);
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

it('emits a parseable JSON result through an npm-style symlink', () => {
  const result = spawnSync(process.execPath, [executable, '--json', '--help'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({
    version: 1,
    type: 'result',
    command: 'help',
    data: { schemaVersion: 1 },
  });
});

it('parses global JSON before rejecting invalid arguments', () => {
  const result = spawnSync(process.execPath, [executable, '--json', 'seek', 'invalid'], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({
    version: 1,
    type: 'error',
    command: 'seek',
    data: { code: 'invalid_arguments' },
  });
});

it('exits after device selection even when the caller keeps stdin open', async () => {
  const loader = join(directory, 'discovery-loader.mjs');
  writeFileSync(loader, `
    export async function load(url, context, nextLoad) {
      if (url.endsWith('/dist/discovery.js')) {
        return { format: 'module', shortCircuit: true, source:
          'export * from ' + JSON.stringify(url + '?actual') +
          '; export async function scan() { return [{ toString() { return "Fixture TV"; } }]; }' };
      }
      return nextLoad(url, context);
    }
  `);
  const child = spawn(process.execPath, ['--loader', loader, executable, 'pair'], {
    env: { ...process.env, HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
  });
  let output = '';
  let errors = '';
  let answered = false;
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    output += chunk;
    if (!answered && output.includes('Select device number:')) {
      answered = true;
      child.stdin.write('0\n'); // Deliberately do not close the caller's input pipe.
    }
  });
  try {
    const [code] = await once(child, 'exit');
    expect(code, errors).toBe(0);
    expect(output).toContain('Invalid selection.');
  } finally {
    child.stdin.destroy();
    child.kill();
  }
}, 10000);
