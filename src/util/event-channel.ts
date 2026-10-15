/**
 * Shared AirPlay 2 event-channel responder. After SETUP returns `eventPort`, the receiver
 * sends RTSP/HTTP requests over a HAP-encrypted TCP connection (keys from `Events-Salt`) and
 * expects each to be acknowledged, or it may tear the session down.
 */

import type { Socket } from 'node:net';
import { connectSocket, parseHTTPMessage, type ParsedHTTP } from '../connection.js';
import { hkdfSha512 } from './crypto.js';
import { HAPSession } from './hap-session.js';

/** Event requests are small control messages (passed as parseHTTPMessage's body cap). */
const MAX_EVENT_BYTES = 1024 * 1024;
/** Some receivers open the event port only after answering SETUP, so refused connects are retried. */
const CONNECT_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1000;

/**
 * Connect to the receiver's event port and answer every request with `200 OK`, echoing
 * `CSeq` (and `Server` when present) on the request's protocol (`RTSP/1.0` or `HTTP/1.1`).
 *
 * `sharedSecret` is the pair-verify (or transient pairing) shared secret; read/write keys are
 * derived from it with `Events-Salt`. Decryption, framing and unknown-protocol errors are
 * reported through `onError` and destroy the socket; the caller owns the returned socket and
 * its `error`/`close` handling. `signal` cancels only the connect and retry waits; once
 * connected, the caller decides when to close (for example after sending TEARDOWN). The
 * derived event keys are zeroed when the socket closes or the connect fails; the caller
 * still owns (and zeroes) `sharedSecret`.
 *
 * @throws (rejects) when aborted, on any connect error other than `ECONNREFUSED`, or on the
 * fifth refused attempt (attempts are 1 s apart).
 */
export async function openEventChannel(host: string, port: number, sharedSecret: Buffer,
  onError: (error: Error) => void, signal?: AbortSignal): Promise<Socket> {
  const [readKey, writeKey] = await Promise.all([
    hkdfSha512(sharedSecret, 'Events-Salt', 'Events-Read-Encryption-Key', 32),
    hkdfSha512(sharedSecret, 'Events-Salt', 'Events-Write-Encryption-Key', 32)]);
  const cipher = new HAPSession(readKey, writeKey);
  let socket: Socket;
  for (let attempt = 1; ; attempt++) {
    try {
      socket = await connectSocket(host, port, undefined, signal);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED' || attempt === CONNECT_ATTEMPTS) { readKey.fill(0); writeKey.fill(0); throw error; }
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); readKey.fill(0); writeKey.fill(0); reject(new Error('Connection closed during setup')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, RETRY_DELAY_MS);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  // The session holds the key Buffers by reference, so zeroing them ends its use too.
  socket.once('close', () => { readKey.fill(0); writeKey.fill(0); });
  let encrypted: Buffer = Buffer.alloc(0), plain: Buffer = Buffer.alloc(0);
  socket.on('data', (data: Buffer) => {
    try {
      encrypted = Buffer.concat([encrypted, data]);
      const decoded = cipher.decryptAvailable(encrypted);
      encrypted = Buffer.from(decoded.rest);
      plain = Buffer.concat([plain, decoded.plaintext]);
      let message: ParsedHTTP | null;
      while ((message = parseHTTPMessage(plain, MAX_EVENT_BYTES))) {
        plain = Buffer.from(plain.subarray(message.totalSize));
        const protocol = message.startLine.split(' ')[2];
        if (!['RTSP/1.0', 'HTTP/1.1'].includes(protocol)) throw new Error('Invalid event request');
        socket.write(cipher.encrypt(Buffer.from(`${protocol} 200 OK\r\nContent-Length: 0\r\nAudio-Latency: 0\r\n${message.headers.cseq ? `CSeq: ${message.headers.cseq}\r\n` : ''}${message.headers.server ? `Server: ${message.headers.server}\r\n` : ''}\r\n`)));
      }
    } catch (error) {
      socket.destroy();
      onError(error as Error);
    }
  });
  return socket;
}
