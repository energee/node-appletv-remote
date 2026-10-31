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
import { FFMPEG_MISSING, openRaopInput } from '../cli/raop-input.js';

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

async function chunks(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const output: Buffer[] = [];
  for await (const chunk of source) output.push(chunk);
  return output;
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
    const file = tempFile('tone.wav', wave(payload));
    const input = await openRaopInput(file, new AbortController().signal);
    expect(input.metadataFile).toBe(file);
    expect(await collect(input.source as AsyncIterable<Buffer>)).toEqual(payload);
    expect(spawned.spawn).not.toHaveBeenCalled();
  });

  it('uses shell-free ffmpeg argv for incompatible WAV and emits bounded complete PCM frames', async () => {
    const child = prepareChild();
    const file = tempFile('tone.wav', wave(Buffer.alloc(16), 22050));
    const inputPromise = openRaopInput(file, new AbortController().signal);
    const input = await inputPromise;
    expect(input.metadataFile).toBe(file);
    child.stdout.write(Buffer.alloc(65535, 0x7f)); child.stdout.write(Buffer.alloc(5, 0x7f));
    child.stdout.end(); child.emit('close', 0, false);
    const output = await chunks(input.source as AsyncIterable<Buffer>);
    expect(Buffer.concat(output)).toEqual(Buffer.alloc(65540, 0x7f));
    expect(output.every(chunk => chunk.length <= 65536 && chunk.length % 4 === 0)).toBe(true);
    expect(spawned.spawn).toHaveBeenCalledWith('ffmpeg', ['-nostdin', '-v', 'error', '-i', expect.stringMatching(/tone\.wav$/), '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('reports a missing ffmpeg before a source is handed to RAOP', async () => {
    const child = new FakeChild();
    spawned.spawn.mockReturnValueOnce(child);
    queueMicrotask(() => { const error = Object.assign(new Error('missing'), { code: 'ENOENT' }); child.emit('error', error); child.emit('close', null, true); });
    await expect(openRaopInput(tempFile('tone.flac', Buffer.from('not flac')), new AbortController().signal)).rejects.toThrow(FFMPEG_MISSING);
  });

  it('routes malformed WAV through ffmpeg instead of the compatible-WAV parser', async () => {
    const child = prepareChild();
    const malformed = Buffer.from('RIFF\xff\xff\xff\xffWAVE');
    const file = tempFile('broken.wav', malformed);
    const input = await openRaopInput(file, new AbortController().signal);
    expect(input.metadataFile).toBeUndefined();
    child.stderr.write('invalid data'); child.stdout.end(); child.stderr.end(); child.emit('close', 1, false);
    await expect(input.failure).resolves.toMatchObject({ message: 'ffmpeg exited with code 1: invalid data' });
    await expect(collect(input.source as AsyncIterable<Buffer>)).rejects.toThrow('ffmpeg exited with code 1: invalid data');
    expect(spawned.spawn).toHaveBeenCalledWith('ffmpeg', expect.arrayContaining([expect.stringMatching(/broken\.wav$/)]), expect.anything());
  });

  it('terminates ffmpeg on abort while its stdout is still open', async () => {
    const child = prepareChild();
    const controller = new AbortController();
    const input = await openRaopInput(tempFile('tone.mp3', Buffer.from('not mp3')), controller.signal);
    controller.abort(new Error('stop'));
    await expect(collect(input.source as AsyncIterable<Buffer>)).rejects.toThrow('stop');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('preserves cancellation when abort interrupts a pending decoder read', async () => {
    const child = prepareChild();
    const controller = new AbortController();
    const input = await openRaopInput('https://example.invalid/audio', controller.signal);
    const iterator = (input.source as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
    child.stdout.write(Buffer.from([1, 0, 1, 0]));
    expect((await iterator.next()).value).toEqual(Buffer.from([1, 0, 1, 0]));
    const reason = new Error('cancelled by caller');
    const pending = expect(iterator.next()).rejects.toBe(reason);
    controller.abort(reason);
    await pending;
    expect(child.stdout.destroyed).toBe(true);
    expect(child.killed).toBe(true);
  });

  it('reports stdout failure before the caller starts consuming and releases the decoder', async () => {
    const child = prepareChild();
    const input = await openRaopInput('https://example.invalid/audio', new AbortController().signal);
    child.stdout.emit('error', new Error('decoder output failed'));
    await expect(input.failure).resolves.toMatchObject({ message: 'decoder output failed' });
    await expect(collect(input.source as AsyncIterable<Buffer>)).rejects.toThrow('decoder output failed');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not treat external signal termination as successful empty audio', async () => {
    const child = prepareChild();
    const input = await openRaopInput('https://example.invalid/audio', new AbortController().signal);
    child.stdout.end(); child.emit('close', null, 'SIGKILL');
    await expect(collect(input.source as AsyncIterable<Buffer>)).rejects.toThrow('ffmpeg exited from SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });
});
