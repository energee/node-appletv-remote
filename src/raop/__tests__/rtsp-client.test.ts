/** Loopback tests for RtspClient's HAP-encrypted control framing and CSeq-less HTTP pairing requests. */
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { RtspClient } from '../stream.js';
import { HAPSession } from '../../util/hap-session.js';
import { connectSocket, parseHTTPMessage } from '../../connection.js';

const clientWrite = Buffer.alloc(32, 0x11);
const clientRead = Buffer.alloc(32, 0x22);

interface Received { startLine: string; headers: Record<string, string>; body: Buffer }
interface Peer {
  client: RtspClient;
  failures: Error[];
  /** Every request the receiver parsed, in order. */
  requests: Received[];
  /** The receiver's connection, for writing raw replies. */
  socket: () => Socket;
  /** Mirror cipher: decrypts what the client sends, encrypts replies for it. */
  cipher: HAPSession;
  /** True once the receiver has seen any bytes it decrypted rather than parsed as plaintext. */
  encryptedSeen: () => boolean;
}

const servers: Server[] = [];
const clients: RtspClient[] = [];
const accepted: Socket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.socket.destroy();
  for (const socket of accepted.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
});

/**
 * Receiver that parses plaintext until `encrypted()` is set, then decrypts with a mirror
 * HAPSession. `reply` decides each response (raw wire bytes); undefined means no reply.
 */
async function peer(reply: (request: Received, cipher: HAPSession, encrypted: boolean) => Buffer | undefined): Promise<Peer & { encrypt: () => void }> {
  const cipher = new HAPSession(clientRead, clientWrite);
  const requests: Received[] = [];
  let encrypted = false; let decryptedAny = false; let serverSocket: Socket | undefined;
  const server = createServer(socket => {
    serverSocket = socket; accepted.push(socket); socket.setNoDelay(true);
    let raw = Buffer.alloc(0); let plain = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      if (encrypted) {
        const { plaintext, rest } = cipher.decryptAvailable(raw); raw = Buffer.from(rest);
        if (plaintext.length) decryptedAny = true;
        plain = Buffer.concat([plain, plaintext]);
      } else { plain = Buffer.concat([plain, raw]); raw = Buffer.alloc(0); }
      while (true) {
        const message = parseHTTPMessage(plain); if (!message) break;
        plain = plain.subarray(message.totalSize);
        const request = { startLine: message.startLine, headers: message.headers, body: message.body };
        requests.push(request);
        const response = reply(request, cipher, encrypted);
        if (response) socket.write(response);
      }
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const failures: Error[] = [];
  const port = (server.address() as { port: number }).port;
  const client = new RtspClient(await connectSocket('127.0.0.1', port), error => failures.push(error));
  clients.push(client); client.setLocalUri(42);
  return { client, failures, requests, cipher, socket: () => serverSocket!, encryptedSeen: () => decryptedAny, encrypt: () => { encrypted = true; } };
}

const rtspReply = (request: Received, extra = '', body = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: ${request.headers.cseq}\r\n${extra}Content-Length: ${body.length}\r\n\r\n`), body]);

describe('RtspClient encryption', () => {
  it('encrypts requests and decrypts CSeq-correlated responses after encryptWith', async () => {
    const receiver = await peer((request, cipher, encrypted) => {
      const response = rtspReply(request, `Session: ${request.startLine.split(' ')[0]}\r\n`);
      return encrypted ? cipher.encrypt(response) : response;
    });
    const plain = await receiver.client.request('OPTIONS');
    expect(plain.headers.session).toBe('OPTIONS');
    expect(receiver.encryptedSeen()).toBe(false);

    receiver.encrypt();
    receiver.client.encryptWith(new HAPSession(clientWrite, clientRead));
    const [setup, record] = await Promise.all([receiver.client.request('SETUP'), receiver.client.request('RECORD')]);
    expect(setup.headers.session).toBe('SETUP');
    expect(record.headers.session).toBe('RECORD');
    expect(receiver.encryptedSeen()).toBe(true);
    expect(receiver.requests.map(request => [request.startLine, request.headers.cseq])).toEqual([
      ['OPTIONS rtsp://127.0.0.1/42 RTSP/1.0', '1'],
      ['SETUP rtsp://127.0.0.1/42 RTSP/1.0', '2'],
      ['RECORD rtsp://127.0.0.1/42 RTSP/1.0', '3'],
    ]);
    expect(receiver.failures).toEqual([]);
  });

  it('reassembles a response split across TCP chunks and across 1,024-byte frames', async () => {
    const body = Buffer.alloc(3000); for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
    let wire: Buffer | undefined;
    const receiver = await peer((request, cipher) => { wire = cipher.encrypt(rtspReply(request, '', body)); return undefined; });
    receiver.encrypt();
    receiver.client.encryptWith(new HAPSession(clientWrite, clientRead));
    const response = receiver.client.request('GET_PARAMETER');
    while (!wire) await delay(1);
    expect(wire.length).toBeGreaterThan(2 * (2 + 1024 + 16)); // at least three frames
    // Uneven slices cut through length prefixes, ciphertext and tags of several frames.
    for (let offset = 0; offset < wire.length; offset += 517) {
      receiver.socket().write(wire.subarray(offset, offset + 517));
      await delay(2);
    }
    expect((await response).body).toEqual(body);
    expect(receiver.failures).toEqual([]);
  });

  it('fails the request and the client when a frame does not authenticate', async () => {
    const receiver = await peer((request, cipher) => {
      const wire = cipher.encrypt(rtspReply(request));
      wire[wire.length - 1] ^= 0x01;
      return wire;
    });
    receiver.encrypt();
    receiver.client.encryptWith(new HAPSession(clientWrite, clientRead));
    await expect(receiver.client.request('SETUP')).rejects.toThrow();
    expect(receiver.failures.length).toBeGreaterThan(0);
    await delay(5);
    expect(receiver.client.socket.destroyed).toBe(true);
  });
});

describe('RtspClient HTTP pairing requests', () => {
  it('sends /pair-pin-start and /pair-setup as HTTP/1.1 without CSeq, passing X-Apple-HKP through', async () => {
    const receiver = await peer(request => {
      const body = Buffer.from(request.startLine.split(' ')[1]);
      return Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`), body]);
    });
    const start = await receiver.client.request('POST', { 'X-Apple-HKP': '4' }, undefined, undefined, 5000, '/pair-pin-start');
    const setup = await receiver.client.request('POST', { 'X-Apple-HKP': '4' }, Buffer.from([1, 2, 3]), undefined, 5000, '/pair-setup');
    expect(start.body.toString()).toBe('/pair-pin-start');
    expect(setup.body.toString()).toBe('/pair-setup');
    for (const request of receiver.requests) {
      expect(request.startLine).toMatch(/^POST \/pair-(pin-start|setup) HTTP\/1\.1$/);
      expect(request.headers.cseq).toBeUndefined();
      expect(request.headers['x-apple-hkp']).toBe('4');
    }
    expect(receiver.requests[1].body).toEqual(Buffer.from([1, 2, 3]));
  });
});
