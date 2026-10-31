/**
 * CLI-only adapters that turn finite files and explicitly selected remote PCM into the PCM
 * contract accepted by RaopStream. Decoding stays outside the packet sender.
 */
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { wavPcm } from '../raop/wav.js';
import type { RaopPcmSource } from '../raop/stream.js';

const MAX_CHUNK = 65536;
const MAX_STDERR = 8192;
const FFMPEG_MISSING = 'ffmpeg is required for this input. Install ffmpeg, or use raw .pcm or PCM16 stereo 44100 Hz .wav input.';

export interface RaopInput {
  source: RaopPcmSource;
  /** Local finite input eligible for tag extraction before RAOP ownership. */
  metadataFile?: string;
  /** Resolves on an asynchronous pre-consumption source failure. */
  failure?: Promise<Error>;
  close(): void;
}

/** Inspect RIFF structure and PCM parameters in one bounded scan without consuming audio. */
function wavProbe(path: string): { wellFormed: boolean; compatible: boolean } {
  const fd = openSync(path, 'r');
  try {
    const length = fstatSync(fd).size;
    const header = Buffer.alloc(12);
    if (length < 20 || readSync(fd, header, 0, 12, 0) !== 12 ||
        header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WAVE') return { wellFormed: false, compatible: false };
    const end = header.readUInt32LE(4) + 8;
    if (end > length || end < 12) return { wellFormed: false, compatible: false };
    let position = 12; let format: Buffer | undefined; let dataSize: number | undefined;
    while (position + 8 <= end) {
      const chunk = Buffer.alloc(8);
      if (readSync(fd, chunk, 0, 8, position) !== 8) return { wellFormed: false, compatible: false };
      const size = chunk.readUInt32LE(4); const next = position + 8 + size + size % 2;
      if (next > end || next < position) return { wellFormed: false, compatible: false };
      const id = chunk.toString('latin1', 0, 4);
      if (id === 'fmt ' && !format && size >= 16 && size <= 1024) {
        format = Buffer.alloc(16);
        if (readSync(fd, format, 0, 16, position + 8) !== 16) return { wellFormed: false, compatible: false };
      } else if (id === 'data' && format && dataSize === undefined) dataSize = size;
      position = next;
    }
    if (position !== end || !format || dataSize === undefined) return { wellFormed: false, compatible: false };
    const compatible = format.readUInt16LE(0) === 1 && format.readUInt16LE(2) === 2 &&
      format.readUInt32LE(4) === 44100 && format.readUInt16LE(14) === 16 && dataSize % 4 === 0;
    return { wellFormed: true, compatible };
  } finally { closeSync(fd); }
}

/** Yield bounded complete PCM16 stereo frames, retaining at most three pending bytes. */
async function* pcmFrames(chunks: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
  let remainder: Buffer = Buffer.alloc(0);
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk)) throw new Error('PCM source must yield Buffers');
    const input = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;
    const complete = input.length - input.length % 4;
    for (let offset = 0; offset < complete; offset += MAX_CHUNK) yield input.subarray(offset, Math.min(offset + MAX_CHUNK, complete));
    remainder = input.subarray(complete);
  }
  if (remainder.length) throw new Error('PCM source ended mid-frame');
}

async function ffmpegInput(input: string, signal: AbortSignal): Promise<RaopInput> {
  const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; let startupError: Error | undefined; let exitError: Error | undefined; let stdoutError: Error | undefined;
  let exited = false; let stopping = false;
  const close = () => {
    stopping = true;
    child.stdout.destroy(); child.stderr.destroy();
    if (!child.killed && !exited) child.kill('SIGTERM');
  };
  child.stderr.on('data', (data: Buffer) => {
    if (stderr.length < MAX_STDERR) stderr += data.toString('utf8', 0, MAX_STDERR - stderr.length);
  });
  let reportFailure!: (error: Error) => void;
  const failure = new Promise<Error>(resolve => { reportFailure = resolve; });
  child.stdout.on('error', (error: Error) => { stdoutError = error; reportFailure(error); close(); });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error: NodeJS.ErrnoException) => {
      startupError = error.code === 'ENOENT' ? new Error(FFMPEG_MISSING) : error; reject(startupError);
    });
  });
  const finished = new Promise<void>((resolve) => child.once('close', (code, terminationSignal) => {
    exited = true;
    if (!startupError && !stopping && (code !== 0 || typeof terminationSignal === 'string')) {
      exitError = new Error(`ffmpeg exited ${terminationSignal ? `from ${terminationSignal}` : `with code ${code}`}${stderr ? `: ${stderr.trim()}` : ''}`);
      reportFailure(exitError);
    }
    resolve();
  }));
  const abort = () => close();
  signal.addEventListener('abort', abort, { once: true });
  try { await started; if (signal.aborted) throw signal.reason; }
  catch (error) { signal.removeEventListener('abort', abort); close(); await finished; throw error; }
  const source = (async function* (): AsyncIterable<Buffer> {
    try {
      if (signal.aborted) throw signal.reason;
      if (stdoutError) throw stdoutError;
      yield* pcmFrames((async function* () {
        for await (const chunk of child.stdout) {
          if (signal.aborted) throw signal.reason;
          if (!Buffer.isBuffer(chunk)) throw new Error('ffmpeg stdout must yield Buffers');
          yield chunk;
        }
      })());
      await finished;
      if (signal.aborted) throw signal.reason;
      if (stdoutError) throw stdoutError;
      if (exitError) throw exitError;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    } finally { signal.removeEventListener('abort', abort); close(); await finished; }
  })();
  return { source, failure, close };
}

/** Select a finite CLI input route without buffering a track. `pcm:` makes remote raw PCM explicit. */
export async function openRaopInput(input: string, signal: AbortSignal): Promise<RaopInput> {
  if (input.startsWith('pcm:http://') || input.startsWith('pcm:https://')) {
    const url = input.slice(4);
    const source = pcmFrames((async function* (): AsyncIterable<Buffer> {
      const response = await fetch(url, { signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Unable to fetch raw PCM: HTTP ${response.status}`);
      }
      const body = Readable.fromWeb(response.body as ReadableStream);
      try {
        for await (const chunk of body) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Remote PCM source must yield Buffers');
          yield chunk;
        }
      } finally { body.destroy(); }
    })());
    return { source, close: () => {} };
  }
  if (/^https?:\/\//i.test(input)) return ffmpegInput(input, signal);
  if (input.toLowerCase().endsWith('.pcm')) {
    const source = pcmFrames((async function* (): AsyncIterable<Buffer> {
      const readable = createReadStream(input, { highWaterMark: MAX_CHUNK });
      try { yield* readable; } finally { readable.destroy(); }
    })());
    return { source, close: () => {} };
  }
  if (input.toLowerCase().endsWith('.wav')) {
    const wav = wavProbe(input);
    if (wav.compatible) {
      const source = (async function* (): AsyncIterable<Buffer> {
        const readable = createReadStream(input, { highWaterMark: MAX_CHUNK });
        yield* wavPcm(readable);
      })();
      return { source, metadataFile: input, close: () => {} };
    }
    const converted = await ffmpegInput(input, signal);
    return { ...converted, ...(wav.wellFormed ? { metadataFile: input } : {}) };
  }
  const converted = await ffmpegInput(input, signal);
  return { ...converted, metadataFile: input };
}

export { FFMPEG_MISSING };
