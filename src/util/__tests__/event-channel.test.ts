/** Loopback tests for the shared encrypted AirPlay 2 event-channel responder; no device. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { openEventChannel } from '../event-channel.js';
import { HAPSession } from '../hap-session.js';
import { hkdfSha512 } from '../crypto.js';
import { closedPort } from '../../raop/__tests__/airplay2-receiver.js';

const secret = Buffer.alloc(32, 0x5a);

/** Receiver-side cipher: it writes with the key the client reads with, and vice versa. */
async function receiverCipher(): Promise<HAPSession> {
  return new HAPSession(
    await hkdfSha512(secret, 'Events-Salt', 'Events-Write-Encryption-Key', 32),
    await hkdfSha512(secret, 'Events-Salt', 'Events-Read-Encryption-Key', 32));
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}


/** Yield real I/O turns until the retry wait has been scheduled on the fake clock. */
async function retryScheduled(): Promise<void> {
  while (vi.getTimerCount() === 0) await new Promise(resolve => setImmediate(resolve));
}

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('openEventChannel', () => {
  it('answers each encrypted request with an encrypted 200 echoing CSeq, including batched and split requests', async () => {
    const cipher = await receiverCipher();
    let replies = '';
    let peer!: Socket;
    const gotThree = new Promise<void>(resolve => {
      const server = createServer(socket => {
        peer = socket;
        let buffer: Buffer = Buffer.alloc(0);
        socket.on('data', (data: Buffer) => {
          buffer = Buffer.concat([buffer, data]);
          const decoded = cipher.decryptAvailable(buffer);
          buffer = Buffer.from(decoded.rest);
          replies += decoded.plaintext.toString();
          if (replies.split('200 OK').length - 1 === 3) resolve();
        });
        socket.write(Buffer.concat([
          cipher.encrypt(Buffer.from('POST /event RTSP/1.0\r\nCSeq: 1\r\nContent-Length: 0\r\n\r\n')),
          cipher.encrypt(Buffer.from('POST /event RTSP/1.0\r\nCSeq: 2\r\nContent-Length: 2\r\n\r\nhi')),
        ]));
        const split = cipher.encrypt(Buffer.from('GET /info HTTP/1.1\r\nCSeq: 3\r\nServer: AirTunes/1\r\nContent-Length: 0\r\n\r\n'));
        socket.write(split.subarray(0, 7));
        setTimeout(() => socket.write(split.subarray(7)), 20);
      });
      servers.push(server);
      void listen(server).then(port => openEventChannel('127.0.0.1', port, secret, onError));
    });
    const onError = vi.fn();
    await gotThree;
    const messages = replies.split('\r\n\r\n').filter(Boolean);
    expect(messages).toEqual([
      'RTSP/1.0 200 OK\r\nContent-Length: 0\r\nAudio-Latency: 0\r\nCSeq: 1',
      'RTSP/1.0 200 OK\r\nContent-Length: 0\r\nAudio-Latency: 0\r\nCSeq: 2',
      'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nAudio-Latency: 0\r\nCSeq: 3\r\nServer: AirTunes/1',
    ]);
    expect(onError).not.toHaveBeenCalled();
    peer.destroy();
  });

  it('reports a frame that fails authentication through onError and closes the channel', async () => {
    const server = createServer(socket => {
      socket.on('error', () => {});
      const frame = Buffer.alloc(2 + 4 + 16, 0x11);
      frame.writeUInt16LE(4);
      socket.write(frame);
    });
    servers.push(server);
    const port = await listen(server);
    const failed = new Promise<Error>(resolve => {
      void openEventChannel('127.0.0.1', port, secret, resolve).then(socket => socket.on('error', () => {}));
    });
    expect(await failed).toBeInstanceOf(Error);
  });

  it('leaves the connected socket to the caller when the signal aborts after connect', async () => {
    const server = createServer(socket => socket.on('error', () => {}));
    servers.push(server);
    const port = await listen(server);
    const controller = new AbortController();
    const socket = await openEventChannel('127.0.0.1', port, secret, () => {}, controller.signal);
    controller.abort();
    expect(socket.destroyed).toBe(false);
    socket.destroy();
  });

  it('retries a refused connect 1 s later and connects once the receiver listens', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const port = await closedPort();
    const opening = openEventChannel('127.0.0.1', port, secret, () => {});
    await retryScheduled();
    const server = createServer(socket => socket.on('error', () => {}));
    servers.push(server);
    await listen(server, port);
    vi.advanceTimersByTime(999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    const socket = await opening;
    expect(socket.remotePort).toBe(port);
    socket.destroy();
  });

  it('rejects after five refused attempts in total', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const port = await closedPort();
    let settled: unknown;
    const opening = openEventChannel('127.0.0.1', port, secret, () => {}).then(() => { settled = 'connected'; }, error => { settled = error; });
    for (let wait = 0; wait < 4; wait++) {
      await retryScheduled();
      expect(settled).toBeUndefined();
      vi.advanceTimersByTime(1000);
    }
    await opening;
    expect((settled as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects without another attempt when aborted during the retry wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const port = await closedPort();
    const controller = new AbortController();
    const opening = openEventChannel('127.0.0.1', port, secret, () => {}, controller.signal);
    await retryScheduled();
    let connections = 0;
    const server = createServer(socket => { connections++; socket.destroy(); });
    servers.push(server);
    await listen(server, port);
    controller.abort();
    await expect(opening).rejects.toThrow('Connection closed during setup');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    await new Promise(resolve => setImmediate(resolve));
    expect(connections).toBe(0);
  });
});
