import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs, type ReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AirPlayPlaybackSession } from '../airplay-playback.js';

const credentials = {
  clientId: 'synthetic-controller', serverId: 'synthetic-receiver',
  clientLTSK: Buffer.alloc(32, 1), clientLTPK: Buffer.alloc(32, 2), serverLTPK: Buffer.alloc(32, 3),
};
afterEach(() => vi.restoreAllMocks());

it('close cancels an in-progress local-file snapshot and releases its owned read stream', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'atv-cancel-file-'));
  const path = join(directory, 'media');
  await fs.writeFile(path, 'abcdef');
  const stalled = new PassThrough();
  // The snapshot pipeline needs only a Readable; this controlled source models a file read that has not finished.
  const fileStream = stalled as unknown as ReadStream;
  let started!: () => void;
  const copying = new Promise<void>(resolve => { started = resolve; });
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    vi.spyOn(handle, 'createReadStream').mockImplementationOnce(() => {
      started();
      return fileStream;
    });
    return handle;
  });
  const playback = new AirPlayPlaybackSession('127.0.0.1', 1, credentials);
  const pending = playback.playFile(path, 0, { address: '127.0.0.1' });
  let rejected = false;
  const settled = pending.then(() => { throw new Error('Canceled playback must reject'); }, () => { rejected = true; });
  try {
    await copying;
    playback.close();
    await vi.waitFor(() => {
      expect(stalled.destroyed).toBe(true);
      expect(rejected).toBe(true);
    });
    await settled;
  } finally {
    playback.close();
    stalled.destroy(new Error('Stop controlled file source'));
    await pending.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});
