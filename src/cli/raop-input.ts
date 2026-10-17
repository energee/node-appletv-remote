/**
 * CLI-only adapters that turn finite files and explicitly selected remote PCM into the PCM
 * contract accepted by RaopStream. Decoding stays outside the packet sender.
 */
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { wavPcm } from '../raop/wav.js';
import type { RaopPcmSource } from '../raop/stream.js';

const MAX_CHUNK = 65536;
const MAX_STDERR = 8192;
const FFMPEG_MISSING = 'ffmpeg is required for this input. Install ffmpeg, or use raw .pcm or PCM16 stereo 44100 Hz .wav input.';

export interface RaopInput {
  source: RaopPcmSource;
  close(): void;
}

function isCompatibleWav(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, header.length, 0) !== header.length ||
        header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') return false;
    let position = 12;
    for (;;) {
      const chunk = Buffer.alloc(8);
      if (readSync(fd, chunk, 0, chunk.length, position) !== chunk.length) return false;
      const size = chunk.readUInt32LE(4);
      if (chunk.toString('latin1', 0, 4) === 'fmt ') {
        if (size < 16 || size > 1024) return false;
        const format = Buffer.alloc(16);
        if (readSync(fd, format, 0, format.length, position + 8) !== format.length) return false;
        return format.readUInt16LE(0) === 1 && format.readUInt16LE(2) === 2 &&
          format.readUInt32LE(4) === 44100 && format.readUInt16LE(14) === 16;
      }
      // Avoid an unbounded or overflowing probe on malformed input. It is decoded by ffmpeg.
      if (size > 16 * 1024 * 1024 || position > Number.MAX_SAFE_INTEGER - size - 9) return false;
      position += 8 + size + size % 2;
    }
  } finally {
    closeSync(fd);
  }
}

async function ffmpegInput(input: string, signal: AbortSignal): Promise<RaopInput> {
  const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let startupError: Error | undefined;
  let exitError: Error | undefined;
  let exited = false;
  const close = () => {
    child.stdout.destroy();
    child.stderr.destroy();
    if (!child.killed && !exited) child.kill('SIGTERM');
  };
  child.stderr.on('data', (data: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += data.toString('utf8', 0, MAX_STDERR - stderr.length);
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error: NodeJS.ErrnoException) => {
      startupError = error.code === 'ENOENT' ? new Error(FFMPEG_MISSING) : error;
      reject(startupError);
    });
  });
  const finished = new Promise<void>((resolve) => child.once('close', (code, killed) => {
    exited = true;
    if (!startupError && code !== 0 && !killed) exitError = new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
    resolve();
  }));
  const abort = () => close();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await started;
    if (signal.aborted) throw signal.reason;
  } catch (error) {
    signal.removeEventListener('abort', abort);
    close();
    await finished;
    throw error;
  }
  const source = (async function* (): AsyncIterable<Buffer> {
    try {
      if (signal.aborted) throw signal.reason;
      for await (const chunk of child.stdout) {
        if (signal.aborted) throw signal.reason;
        if (!Buffer.isBuffer(chunk)) throw new Error('ffmpeg stdout must yield Buffers');
        for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) yield chunk.subarray(offset, offset + MAX_CHUNK);
      }
      await finished;
      if (exitError) throw exitError;
    } finally {
      signal.removeEventListener('abort', abort);
      close();
      await finished;
    }
  })();
  return { source, close };
}

/** Select a finite CLI input route without buffering a track. `pcm:` makes remote raw PCM explicit. */
export async function openRaopInput(input: string, signal: AbortSignal): Promise<RaopInput> {
  if (input.startsWith('pcm:http://') || input.startsWith('pcm:https://')) {
    const url = input.slice(4);
    const source = (async function* (): AsyncIterable<Buffer> {
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) throw new Error(`Unable to fetch raw PCM: HTTP ${response.status}`);
      const body = Readable.fromWeb(response.body as ReadableStream);
      try {
        for await (const chunk of body) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Remote PCM source must yield Buffers');
          for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) yield chunk.subarray(offset, offset + MAX_CHUNK);
        }
      } finally { body.destroy(); }
    })();
    return { source, close: () => {} };
  }
  if (/^https?:\/\//i.test(input)) return ffmpegInput(input, signal);
  if (input.toLowerCase().endsWith('.pcm')) {
    const source = createReadStream(input, { highWaterMark: MAX_CHUNK });
    return { source, close: () => source.destroy?.() };
  }
  if (input.toLowerCase().endsWith('.wav') && isCompatibleWav(input)) {
    const readable = createReadStream(input, { highWaterMark: MAX_CHUNK });
    return { source: wavPcm(readable), close: () => readable.destroy?.() };
  }
  return ffmpegInput(input, signal);
}

export { FFMPEG_MISSING };
