/** Shared HTTP compatibility, truncation and response-size guard tests. */
import { createServer, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { PersistentHttp } from '../http.js';
let server: Server;
let client: PersistentHttp;
afterEach(async () => { client?.destroy(); if (server) await new Promise<void>((r) => server.close(() => r())); });
async function listen(): Promise<number> { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); return (server.address() as AddressInfo).port; }
it('preserves HAP POST headers and request body on a reusable connection', async () => {
  const received: { hkp?: string; body: string; method?: string }[] = [];
  server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    received.push({ hkp: req.headers['x-apple-hkp'] as string, body, method: req.method }); res.end('ok');
  });
  client = new PersistentHttp('127.0.0.1', await listen());
  expect((await client.post('/pair-setup', Buffer.from('first'))).toString()).toBe('ok');
  await client.post('/pair-verify', Buffer.from('second'));
  expect(received).toEqual([{ hkp: '3', body: 'first', method: 'POST' }, { hkp: '3', body: 'second', method: 'POST' }]);
});
it('rejects responses larger than the cap', async () => {
  server = createServer((_req, res) => res.end(Buffer.alloc(8 * 1024 * 1024 + 1)));
  client = new PersistentHttp('127.0.0.1', await listen());
  await expect(client.request('GET', '/large')).rejects.toThrow(/size limit|aborted/);
});
it('rejects an incomplete response rather than hanging', async () => {
  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Length': '100' }); res.write('x'); setImmediate(() => res.destroy()); });
  client = new PersistentHttp('127.0.0.1', await listen());
  await expect(client.request('GET', '/truncated')).rejects.toThrow();
});
it('applies a configurable inactivity timeout, where 0 disables it for long polls', async () => {
  server = createServer((_req, res) => { setTimeout(() => res.end('late'), 150); });
  const port = await listen();
  client = new PersistentHttp('127.0.0.1', port, {}, 30);
  await expect(client.request('GET', '/slow')).rejects.toThrow(/timeout/);
  client.destroy();
  client = new PersistentHttp('127.0.0.1', port, {}, 0);
  expect((await client.request('GET', '/slow')).body.toString()).toBe('late');
});
it('bounds the TCP connect phase even when the inactivity timeout is disabled', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    client = new PersistentHttp('192.0.2.1', 3689, {}, 0);
    // A socket stuck in `connecting` is what a silently dropped SYN looks like; no network needed.
    (client as unknown as { agent: { createConnection: () => Socket } }).agent.createConnection = () => Object.assign(new Socket(), { connecting: true });
    const pending = expect(client.request('GET', '/login')).rejects.toThrow(/Connect to 192\.0\.2\.1:3689 timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
  } finally { vi.useRealTimers(); }
});
