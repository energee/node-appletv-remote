/** Explicit legacy AirPlay URL playback over the HTTP /play and reverse-event protocol. */
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { DOMParser } from '@xmldom/xmldom';
import { connectSocket, hostForURL, parseHTTPMessage, type ParsedHTTP } from './connection.js';
import { verifyLegacyPairing } from './auth/legacy-pair-verify.js';
import type { LegacyAirPlayCredentials } from './auth/legacy-pair-setup.js';
import type { AirPlayPlaybackStatus } from './airplay-playback.js';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5000;
const XML_PARSER = new DOMParser({ onError: () => { throw new Error('Invalid legacy AirPlay plist'); } });
const VIDEO_STATES: Record<string, true> = { loading: true, playing: true, paused: true, stopped: true };
const COMPOUND_PLIST_TYPES: Record<string, true> = { array: true, dict: true, data: true, date: true };
const INTEGER_PATTERN = /^[+-]?\d+$/;
const REAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export interface LegacyAirPlayPlaybackOptions {
  /** Known finite media duration in seconds, required when `position` is nonzero. */
  duration?: number;
}

type Pending = { resolve: (message: ParsedHTTP) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Explicit legacy HTTP playback, password-free or using caller-held LegacyPairSetup credentials.
 * Never falls back from modern playback. Physical legacy HTTP interoperability remains unverified.
 */
export class LegacyAirPlayPlaybackSession {
  private control?: Socket;
  private reverse?: Socket;
  private controlBuffer = Buffer.alloc(0);
  private reverseBuffer = Buffer.alloc(0);
  private pending?: Pending;
  private queue: Promise<unknown> = Promise.resolve();
  private connecting?: Promise<void>;
  private closed = false;
  private failure?: Error;
  private connectAbort?: AbortController;
  private reverseUpgradeReject?: (error: Error) => void;
  private started = false;
  private starting = false;
  private readonly sessionId = randomUUID();

  constructor(private readonly host: string, private readonly port: number, private readonly credentials?: LegacyAirPlayCredentials) {
    if (!host || /[\s\r\n\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected AirPlay host and valid port');
    if (credentials !== undefined && (typeof credentials !== 'object' || credentials === null
      || typeof credentials.clientId !== 'string' || !/^[0-9a-f]{16}$/i.test(credentials.clientId)
      || !Buffer.isBuffer(credentials.seed) || credentials.seed.length !== 32)) {
      throw new Error('Expected explicit legacy AirPlay credentials with a clientId and 32-byte seed');
    }
  }

  /** Queue one URL; seconds convert to a relative start only with known duration. HTTP acceptance is not startup. */
  async playUrl(url: string, position = 0, options: LegacyAirPlayPlaybackOptions = {}): Promise<void> {
    if (this.started || this.starting) throw new Error('Legacy AirPlay playback session is one-shot');
    const mediaUrl = validateUrl(url);
    const fraction = startFraction(position, options.duration);
    this.starting = true;
    try {
      await this.ensureConnected();
      const body = Buffer.from(`Content-Location: ${mediaUrl}\r\nStart-Position: ${fraction}\r\n`, 'utf8');
      await this.request('POST', '/play', body, { 'Content-Type': 'text/parameters' });
      this.started = true;
    } finally { this.starting = false; }
  }

  /** Read receiver XML status; no background polling or binary-plist fallback. */
  async getStatus(): Promise<AirPlayPlaybackStatus> {
    if (!this.started) throw new Error('Legacy AirPlay playback has not started');
    const response = await this.request('GET', '/playback-info');
    try {
      return statusFromPlist(parseLegacyPlist(response.body));
    } catch {
      const error = new Error('Invalid playback-info plist');
      this.fail(error);
      throw error;
    }
  }

  /** Release local resources and reject waiters; no receiver /stop command is sent. */
  close(): void {
    this.closed = true;
    this.failure ??= new Error('Legacy AirPlay playback session closed');
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.connectAbort?.abort(this.failure);
    this.reverseUpgradeReject?.(this.failure);
    this.reverseUpgradeReject = undefined;
    this.control?.destroy();
    this.reverse?.destroy();
    this.control = undefined;
    this.reverse = undefined;
    this.controlBuffer = Buffer.alloc(0);
    this.reverseBuffer = Buffer.alloc(0);
  }

  private async ensureConnected(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.control && this.reverse) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const abort = new AbortController();
    this.connectAbort = abort;
    try {
      const control = await connectSocket(this.host, this.port, undefined, abort.signal);
      this.control = control;
      if (this.closed) throw this.failure ?? new Error('Legacy AirPlay playback session closed');
      control.on('data', (chunk: Buffer) => this.onControlData(chunk));
      control.on('error', error => this.fail(error));
      control.on('close', () => this.fail(new Error('Legacy AirPlay control connection closed')));
      if (this.credentials) {
        await verifyLegacyPairing({
          post: async (path, body) => (await this.request('POST', path, body, {
            'Content-Type': 'application/octet-stream', Connection: 'keep-alive',
          })).body,
        }, this.credentials.seed);
      }
      if (this.closed) throw this.failure ?? new Error('Legacy AirPlay playback session closed');
      const reverse = await connectSocket(this.host, this.port, undefined, abort.signal);
      this.reverse = reverse;
      // Reverse data is parsed as an upgrade response before it becomes event traffic.
      reverse.on('error', error => this.fail(error));
      reverse.on('close', () => { if (!this.closed) this.fail(new Error('Legacy AirPlay reverse connection closed')); });
      await this.upgradeReverse();
    } catch (error) {
      this.fail(error as Error);
      throw error;
    } finally {
      if (this.connectAbort === abort) this.connectAbort = undefined;
    }
  }

  private request(method: 'GET' | 'POST', path: string, body: Buffer = Buffer.alloc(0), headers: Record<string, string> = {}): Promise<ParsedHTTP> {
    const operation = this.queue.then(() => new Promise<ParsedHTTP>((resolve, reject) => {
      if (this.failure) { reject(this.failure); return; }
      const socket = this.control;
      if (!socket || socket.destroyed) { reject(new Error('Legacy AirPlay playback session not connected')); return; }
      const timer = setTimeout(() => this.fail(new Error(`Legacy AirPlay ${method} timeout`)), REQUEST_TIMEOUT_MS);
      const finish = (error?: Error, response?: ParsedHTTP): void => {
        if (!this.pending) return;
        clearTimeout(timer); this.pending = undefined;
        if (error) reject(error); else resolve(response!);
      };
      this.pending = { resolve: response => finish(undefined, response), reject: error => finish(error), timer };
      const head = [`${method} ${path} HTTP/1.1`, `Host: ${hostForURL(this.host, false)}:${this.port}`, 'User-Agent: AirPlay/320.20', `X-Apple-Session-ID: ${this.sessionId}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), `Content-Length: ${body.length}`, '', ''].join('\r\n');
      socket.write(Buffer.concat([Buffer.from(head, 'ascii'), body]), error => { if (error) this.fail(error); });
    }));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private onControlData(chunk: Buffer): void {
    try {
      this.controlBuffer = Buffer.concat([this.controlBuffer, chunk]);
      while (true) {
        const response = parseHTTPMessage(this.controlBuffer, MAX_MESSAGE_BYTES);
        if (!response) return;
        this.controlBuffer = this.controlBuffer.subarray(response.totalSize);
        if (!/^HTTP\/1\.1 \d{3}(?: |$)/.test(response.startLine) || !this.pending) throw new Error('Unexpected legacy AirPlay response');
        const status = Number(response.startLine.slice(9, 12));
        if (status === 401) throw new Error('Legacy AirPlay authentication rejected (Digest password authentication is not configured)');
        if (status < 200 || status >= 300) throw new Error(`Legacy AirPlay request failed: ${status}`);
        this.pending.resolve(response);
      }
    } catch (error) { this.fail(error as Error); }
  }

  private async upgradeReverse(): Promise<void> {
    const reverse = this.reverse!;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Legacy AirPlay reverse upgrade timeout')), REQUEST_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.reverseUpgradeReject = undefined;
        if (error) reject(error); else resolve();
      };
      this.reverseUpgradeReject = finish;
      const upgraded = (chunk: Buffer): void => {
        try {
          this.reverseBuffer = Buffer.concat([this.reverseBuffer, chunk]);
          const response = parseHTTPMessage(this.reverseBuffer, MAX_MESSAGE_BYTES);
          if (!response) return;
          this.reverseBuffer = this.reverseBuffer.subarray(response.totalSize);
          if (!/^HTTP\/1\.1 101(?: |$)/.test(response.startLine) || response.headers.upgrade?.toLowerCase() !== 'ptth/1.0') throw new Error('Invalid legacy AirPlay reverse upgrade');
          reverse.removeListener('data', upgraded);
          this.reverseUpgradeReject = undefined;
          reverse.on('data', (event: Buffer) => this.onReverseData(event));
          finish();
          if (this.reverseBuffer.length) this.onReverseData(Buffer.alloc(0));
        } catch (error) { reverse.removeListener('data', upgraded); finish(error as Error); }
      };
      reverse.on('data', upgraded);
      const head = [`POST /reverse HTTP/1.1`, `Host: ${hostForURL(this.host, false)}:${this.port}`, 'User-Agent: AirPlay/320.20', 'Connection: Upgrade', 'Upgrade: PTTH/1.0', 'X-Apple-Purpose: event', `X-Apple-Session-ID: ${this.sessionId}`, 'Content-Length: 0', '', ''].join('\r\n');
      reverse.write(head, error => { if (error) { reverse.removeListener('data', upgraded); finish(error); } });
    });
  }

  private onReverseData(chunk: Buffer): void {
    try {
      this.reverseBuffer = Buffer.concat([this.reverseBuffer, chunk]);
      while (true) {
        const event = parseHTTPMessage(this.reverseBuffer, MAX_MESSAGE_BYTES);
        if (!event) return;
        this.reverseBuffer = this.reverseBuffer.subarray(event.totalSize);
        if (!/^POST \/event HTTP\/1\.1$/.test(event.startLine)) throw new Error('Invalid legacy AirPlay reverse event');
        const notice = parseLegacyPlist(event.body);
        if (notice.category !== 'video' || !Number.isInteger(notice.sessionID)
          || typeof notice.state !== 'string' || !Object.hasOwn(VIDEO_STATES, notice.state)) {
          throw new Error('Invalid legacy AirPlay reverse event body');
        }
        const stopped = notice.state === 'stopped' && this.started;
        this.reverse?.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', error => {
          if (error) this.fail(error);
          else if (stopped) this.close();
        });
        if (stopped) return;
      }
    } catch (error) { this.fail(error as Error); }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.close();
  }
}

function validateUrl(url: string): string {
  if (typeof url !== 'string' || /[\r\n\0]/.test(url)) throw new Error('Invalid media URL');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Invalid media URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid media URL');
  return parsed.href;
}

function startFraction(position: number, duration: number | undefined): number {
  if (!Number.isFinite(position) || position < 0) throw new Error('position must be a non-negative finite number of seconds');
  if (position === 0) return 0;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('Nonzero legacy start position requires a known positive duration');
  if (position > duration) throw new Error('Legacy start position exceeds known duration');
  return position / duration;
}

function statusFromPlist(info: Record<string, unknown>): AirPlayPlaybackStatus {
  const number = (key: string): number | undefined => {
    const candidate = info[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) throw new Error(`Invalid playback-info ${key}`);
    return candidate;
  };
  const ready = info.readyToPlay;
  if (ready !== undefined && typeof ready !== 'boolean') throw new Error('Invalid playback-info readyToPlay');
  const duration = number('duration'); const position = number('position'); const rate = number('rate');
  if (duration !== undefined && position !== undefined && position > duration) throw new Error('Invalid playback-info position');
  let state: AirPlayPlaybackStatus['state'] = 'idle';
  if (ready === true && rate !== undefined) state = rate > 0 ? 'playing' : 'paused';
  const result: AirPlayPlaybackStatus = { state };
  if (duration !== undefined) result.duration = duration;
  if (position !== undefined) result.position = position;
  if (rate !== undefined) result.rate = rate;
  return result;
}

function isSafePlistDocument(document: string): boolean {
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(document)) return false;
  const declarations = document.match(/<!DOCTYPE[\s\S]*?>/gi) ?? [];
  return declarations.length === 0 || (declarations.length === 1
    && /^<!DOCTYPE\s+plist\s+PUBLIC\s+["']-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN["']\s+["']https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd["']\s*>$/i.test(declarations[0]));
}

/** Decode only the scalar fields this protocol uses; leave unneeded compound values unallocated. */
function parseLegacyPlist(body: Buffer): Record<string, unknown> {
  try {
    const xml = body.toString('utf8');
    if (!isSafePlistDocument(xml)) throw new Error('Unsafe plist document');
    const document = XML_PARSER.parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    const dictionary = root?.children.item(0);
    if (root?.tagName !== 'plist' || root.children.length !== 1 || dictionary?.tagName !== 'dict') {
      throw new Error('Expected plist dictionary');
    }
    const entries = dictionary.children;
    if (entries.length % 2) throw new Error('Unpaired plist dictionary key');
    const result: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < entries.length; index += 2) {
      const key = entries.item(index)!;
      const value = entries.item(index + 1)!;
      if (key.tagName !== 'key' || key.children.length) throw new Error('Invalid plist dictionary key');
      const name = key.textContent ?? '';
      if (Object.hasOwn(result, name)) throw new Error('Duplicate plist dictionary key');
      if (Object.hasOwn(COMPOUND_PLIST_TYPES, value.tagName)) {
        result[name] = null;
        continue;
      }
      if (value.children.length) throw new Error('Invalid plist scalar');
      const text = value.textContent ?? '';
      switch (value.tagName) {
        case 'string': result[name] = text; break;
        case 'integer':
        case 'real': {
          const numeric = text.trim();
          if (!(value.tagName === 'integer' ? INTEGER_PATTERN : REAL_PATTERN).test(numeric)) {
            throw new Error('Invalid plist number');
          }
          const number = Number(numeric);
          if (!Number.isFinite(number) || (value.tagName === 'integer' && !Number.isSafeInteger(number))) {
            throw new Error('Unrepresentable plist number');
          }
          result[name] = number;
          break;
        }
        case 'true':
        case 'false':
          if (text.trim()) throw new Error('Invalid plist boolean');
          result[name] = value.tagName === 'true';
          break;
        default: throw new Error('Invalid plist value');
      }
    }
    return result;
  } catch { throw new Error('Invalid legacy AirPlay plist'); }
}
