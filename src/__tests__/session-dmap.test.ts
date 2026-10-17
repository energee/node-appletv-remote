/** Unified session against a real HTTP DMAP receiver, including metadata and close ownership. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DeviceSession } from '../session.js';
import { encodeDmap } from '../dmap/codec.js';
import { Key } from '../appletv.js';

function status() {
  return encodeDmap('cmst', Buffer.concat([
    encodeDmap('mstt', Buffer.from([0, 0, 0, 200])), encodeDmap('cmsr', Buffer.from([0, 0, 0, 1])), encodeDmap('caps', Buffer.from([4])),
    encodeDmap('cann', 'Synthetic track'), encodeDmap('cana', 'Synthetic artist'),
    encodeDmap('cast', Buffer.from([0, 1, 0xd4, 0xc0])), encodeDmap('cant', Buffer.from([0, 1, 0x5f, 0x90])),
  ]));
}

describe('DMAP session', () => {
  it('uses only real DMAP implementations and preserves normalized state', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      paths.push(path);
      response.setHeader('Content-Type', 'application/x-dmap-tagged');
      response.end(path === '/login' ? Buffer.from('6d6c6f67000000186d73747400000004000000c86d6c69640000000400000007', 'hex') :
        path.endsWith('/playstatusupdate') ? status() : Buffer.alloc(0));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing receiver address');
    const session = new DeviceSession({ name: 'DMAP', deviceId: 'dmap', address: '127.0.0.1', port: 0, model: 'AppleTV3,2', dmapPort: address.port },
      { credentials: { dmap: '0x0000000000000001' } });
    try {
      await session.connect();
      const snapshots: string[] = [];
      session.on('nowPlaying', info => snapshots.push(info.title));
      const info = await session.execute('getNowPlaying');
      expect(info).toMatchObject({ title: 'Synthetic track', artist: 'Synthetic artist', duration: 120, elapsedTime: 30 });
      expect(session.nowPlaying.title).toBe('Synthetic track');
      expect(snapshots).toEqual(['Synthetic track']);
      const beforeInvalidAction = paths.length;
      await expect(session.execute('up', 'hold')).rejects.toThrow('DMAP does not support input action modes');
      expect(paths.length).toBe(beforeInvalidAction);
      await session.execute('pause');
      await session.sendKeyCommand(Key.PlayPause);
      expect(paths).toEqual(['/login', '/ctrl-int/1/playstatusupdate', '/ctrl-int/1/pause', '/ctrl-int/1/playpause']);
      expect(session.featureAvailability('requestPlaybackQueue')).toBe('unsupported');
      await expect(session.execute('requestPlaybackQueue')).rejects.toThrow('No usable control transport');
      await session.close();
      expect(session.nowPlaying.hasPlayback).toBe(false);
      await expect(session.execute('play')).rejects.toThrow('not ready');
    } finally {
      await session.close(); server.close(); server.closeAllConnections();
      await once(server, 'close');
    }
  });

  it('cancels an actual in-flight login without retaining a socket or publishing ready', async () => {
    let requestReceived!: () => void;
    const received = new Promise<void>(resolve => { requestReceived = resolve; });
    const server = createServer(() => { requestReceived(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing receiver address');
    const session = new DeviceSession({ name: 'DMAP', deviceId: 'dmap', address: '127.0.0.1', port: 0, model: '', dmapPort: address.port },
      { credentials: { dmap: '0x0000000000000001' } });
    let ready = false;
    session.on('ready', () => { ready = true; });
    const setup = session.connect().catch((error: unknown) => error);
    try {
      await received;
      await session.close();
      const error = await setup;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Session closed during setup');
      expect(ready).toBe(false);
      expect(session.featureAvailability('play')).toBe('unavailable');
    } finally {
      await session.close(); server.close(); server.closeAllConnections();
      await once(server, 'close');
    }
  });

  it('invalidates cached state and availability after terminal DMAP authentication loss', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      paths.push(path);
      if (path === '/login') response.end(Buffer.from('6d6c6f67000000186d73747400000004000000c86d6c69640000000400000007', 'hex'));
      else if (path.endsWith('/playstatusupdate')) response.end(status());
      else { response.statusCode = 401; response.end(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing receiver address');
    const session = new DeviceSession({ name: 'DMAP', deviceId: 'dmap', address: '127.0.0.1', port: 0, model: '', dmapPort: address.port },
      { credentials: { dmap: '0x0000000000000001' } });
    try {
      await session.connect();
      await session.execute('getNowPlaying');
      expect(session.nowPlaying.title).toBe('Synthetic track');
      await expect(session.execute('play')).rejects.toThrow('DMAP HTTP 401');
      expect(session.featureAvailability('play')).toBe('unavailable');
      expect(session.nowPlaying.hasPlayback).toBe(false);
      const sent = paths.length;
      await expect(session.execute('pause')).rejects.toThrow('No usable control transport');
      expect(paths.length).toBe(sent);
    } finally {
      await session.close(); server.close(); server.closeAllConnections();
      await once(server, 'close');
    }
  });
});
