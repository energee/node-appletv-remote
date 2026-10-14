/** Reverse pairing fixtures: Remote PIN hash, GUID response and cleanup. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { Service } from 'bonjour-service';
import { DmapPairing } from '../pairing.js';
import { decodeDmap } from '../codec.js';
const published = vi.hoisted(() => ({ options: {} as Record<string, unknown>, service: undefined as import('bonjour-service').Service | undefined, stop: vi.fn(), destroy: vi.fn() }));
vi.mock('bonjour-service', async (original) => ({ ...(await original<typeof import('bonjour-service')>()), Bonjour: class {
  publish(options: Record<string, unknown>) {
    published.options = options;
    // 1.4 requires lifecycle callbacks; 1.3 ignores them. Keep real records without mDNS sockets.
    const service = Reflect.construct(Service, [options, () => {}, published.stop]) as Service;
    service.stop = published.stop;
    published.service = service;
    return service;
  }
  destroy() { published.destroy(); }
} }));
let pairing: DmapPairing | undefined;
afterEach(async () => { await pairing?.close(); pairing = undefined; vi.clearAllMocks(); });

describe('DMAP pairing', () => {
  it('validates four-digit PINs and generates the pinned MD5 challenge', () => {
    pairing = new DmapPairing({ name: 'Remote', address: '127.0.0.1', pin: '1234', guid: '0x0000000000000001' });
    // MD5 of ASCII 0000000000000001 followed by 1\0 2\0 3\0 4\0.
    expect(pairing.pairingCode()).toBe('690e6ff61e0d7c747654a42aed17047d');
    expect(() => new DmapPairing({ name: 'Remote', address: '127.0.0.1', pin: '12' })).toThrow(/PIN/);
  });
  it('advertises reversed pairing and returns credentials only after a valid callback', async () => {
    pairing = new DmapPairing({ name: 'Remote', address: '127.0.0.1', pin: '1234', guid: '0x0000000000000001' });
    await pairing.start();
    expect(published.options.type).toBe('touch-remote');
    const addresses = published.service!.records().filter((r) => r.type === 'A' || r.type === 'AAAA');
    expect(addresses.map((r) => r.data)).toEqual(['127.0.0.1']);
    expect((published.options.txt as Record<string, string>).Pair).toBe('0000000000000001');
    expect(() => pairing!.finish()).toThrow(/not paired/i);
    const malformed = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: published.options.port as number, path: '//', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(malformed).toBe(400);
    const url = `http://127.0.0.1:${published.options.port}/pair`;
    expect((await fetch(url + '?servicename=TV&pairingcode=wrong')).status).toBe(500);
    expect(() => pairing!.finish()).toThrow(/not paired/i);
    const response = await fetch(url + '?servicename=TV&pairingcode=690e6ff61e0d7c747654a42aed17047d');
    expect(response.status).toBe(200);
    expect(decodeDmap(Buffer.from(await response.arrayBuffer()))).toEqual({ cmpa: { cmpg: 1n, cmnm: 'Remote', cmty: 'iPhone' } });
    expect(pairing.finish()).toBe('0x0000000000000001');
    expect((await fetch(url + '?servicename=TV&pairingcode=690e6ff61e0d7c747654a42aed17047d')).status).toBe(409);
    await pairing.close(); expect(published.stop).toHaveBeenCalledOnce(); expect(published.destroy).toHaveBeenCalledOnce();
    await expect(fetch(url)).rejects.toThrow();
  });
});

it('locks pairing after five failed PIN callbacks', async () => {
  pairing = new DmapPairing({ name: 'Remote', address: '127.0.0.1', pin: '1234', guid: '0x0000000000000001' });
  await pairing.start(); const url = `http://127.0.0.1:${published.options.port}/pair?servicename=TV&pairingcode=`;
  for (let i = 0; i < 5; i++) await fetch(url + '00000000000000000000000000000000');
  expect((await fetch(url + '690e6ff61e0d7c747654a42aed17047d')).status).toBe(429);
  expect(() => pairing!.finish()).toThrow(/not paired/i);
});

it('rejects startup promptly when pairing is closed before listening', async () => {
  pairing = new DmapPairing({ name: 'Remote', address: '127.0.0.1', pin: '1234' });
  const started = pairing.start().then(() => 'started', () => 'closed');
  await pairing.close();
  expect(await Promise.race([started, new Promise(resolve => setTimeout(() => resolve('hung'), 50))])).toBe('closed');
});
