/** CLI audio input routing and ffmpeg lifecycle, without a receiver. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ children: [] as FakeChild[], spawn: vi.fn() }));
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn(() => { this.killed = true; this.emit('close', null, true); return true; });
}
vi.mock('node:child_process', () => ({ spawn: spawned.spawn }));
import { FFMPEG_MISSING, openRaopInput } from './raop-input.js';

const paths: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  spawned.children = [];
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempFile(name: string, content: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), 'atv-raop-input-'));
  paths.push(directory);
  const file = join(directory, name);
  writeFileSync(file, content);
  return file;
}

function wave(payload: Buffer, rate = 44100): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + payload.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function prepareChild(): FakeChild {
  const child = new FakeChild();
  spawned.children.push(child);
  spawned.spawn.mockReturnValueOnce(child);
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

describe('openRaopInput', () => {
  it('keeps compatible WAV local and sends only its PCM payload', async () => {
    const payload = Buffer.alloc(16, 0x55);
    const input = await openRaopInput(tempFile('tone.wav', wave(payload)), new AbortController().signal);
    expect(await collect(input.source as AsyncIterable<Buffer>)).toEqual(payload);
    expect(spawned.spawn).not.toHaveBeenCalled();
  });

  it('uses shell-free ffmpeg argv for incompatible WAV and preserves bounded PCM output', async () => {
    const child = prepareChild();
    const inputPromise = openRaopInput(tempFile('tone.wav', wave(Buffer.alloc(16), 22050)), new AbortController().signal);
    const input = await inputPromise;
    child.stdout.write(Buffer.alloc(70000, 0x7f)); child.stdout.end(); child.emit('close', 0, false);
    const output = await collect(input.source as AsyncIterable<Buffer>);
    expect(output).toHaveLength(70000);
    expect(spawned.spawn).toHaveBeenCalledWith('ffmpeg', ['-nostdin', '-v', 'error', '-i', expect.stringMatching(/tone\.wav$/), '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('reports a missing ffmpeg before a source is handed to RAOP', async () => {
    const child = new FakeChild();
    spawned.spawn.mockReturnValueOnce(child);
    queueMicrotask(() => { const error = Object.assign(new Error('missing'), { code: 'ENOENT' }); child.emit('error', error); child.emit('close', null, true); });
    await expect(openRaopInput(tempFile('tone.flac', Buffer.from('not flac')), new AbortController().signal)).rejects.toThrow(FFMPEG_MISSING);
  });

  it('terminates ffmpeg on abort while its stdout is still open', async () => {
    const child = prepareChild();
    const controller = new AbortController();
    const input = await openRaopInput(tempFile('tone.mp3', Buffer.from('not mp3')), controller.signal);
    controller.abort(new Error('stop'));
    await expect(collect(input.source as AsyncIterable<Buffer>)).rejects.toThrow('stop');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
