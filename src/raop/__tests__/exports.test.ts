/** Public RAOP API availability without implicit network activity. */
import { expect, it } from 'vitest';
import * as api from '../../index.js';
it('exports the standalone legacy RAOP stream', () => {
  expect('RaopStream' in api && typeof api.RaopStream).toBe('function');
});
it('exports the WAV PCM reader', () => {
  expect('wavPcm' in api && typeof api.wavPcm).toBe('function');
});
it('exports legacy PIN pair-setup', () => {
  expect('LegacyPairSetup' in api && typeof api.LegacyPairSetup).toBe('function');
});
