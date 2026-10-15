/** The CLI run-as-script guard must not throw at import when argv[1] cannot be resolved. */
import { expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  realpathSync: () => { throw new Error('ENOENT: no such file or directory'); },
}));

it('imports without running when argv[1] cannot be resolved', async () => {
  await expect(import('../cli/index.js')).resolves.toHaveProperty('main');
});
