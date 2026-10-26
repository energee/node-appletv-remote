/**
 * Runs before each test file: point HOME at a fresh temp dir so code that resolves ~/.atv-*
 * files at import (the CLI's storage, credentials and device cache) never touches the real home.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'atv-test-home-'));
