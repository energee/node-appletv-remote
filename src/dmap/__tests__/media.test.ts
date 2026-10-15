/** Loopback tests for DMAP volume, seek, skip, shuffle/repeat, artwork and push updates. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DmapClient } from '../client.js';
import { encodeDmap } from '../codec.js';
import { RepeatState, ShuffleState } from '../../appletv.js';
import type { NowPlayingInfo } from '../../now-playing-info.js';

type Reply = { status?: number; body?: Buffer };
const resources: { server: Server; client: DmapClient }[] = [];
afterEach(async () => { for (const { server, client } of resources.splice(0)) { client.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); } });
const login = Buffer.from('6d6c6f67000000186d73747400000004000000c86d6c69640000000400000007', 'hex');
const u8 = (n: number) => Buffer.from([n]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
/** cmst play status: playing, 120 s long, `remaining` ms left, optional extra tags. */
const status = (remaining: number, ...extra: Buffer[]) => encodeDmap('cmst', Buffer.concat([
  encodeDmap('mstt', u32(200)), encodeDmap('caps', u8(4)), encodeDmap('cast', u32(120000)), encodeDmap('cant', u32(remaining)), ...extra,
]));

async function peer(handler: (url: URL, body: Buffer) => Reply | Promise<Reply>) {
  const seen: { url: URL; method: string }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url!, 'http://localhost');
    seen.push({ url, method: req.method! });
    const reply = url.pathname === '/login' ? { body: login } : await handler(url, Buffer.alloc(0));
    res.writeHead(reply.status ?? 200); res.end(reply.body ?? Buffer.alloc(0));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const client = new DmapClient({ address: '127.0.0.1', dmapPort: (server.address() as AddressInfo).port });
  resources.push({ server, client });
  await client.connect('0x0000000000000001');
  const commands = () => seen.filter((s) => s.url.pathname !== '/login');
  return { client, seen, commands };
}

describe('DMAP volume, seek, shuffle and repeat', () => {
  it('steps volume through ctrl-int commands', async () => {
    const { client, commands } = await peer(() => ({}));
    await client.volumeUp(); await client.volumeDown();
    expect(commands().map((s) => [s.method, s.url.pathname, s.url.searchParams.get('prompt-id'), s.url.searchParams.get('session-id')])).toEqual([
      ['POST', '/ctrl-int/1/volumeup', '0', '7'], ['POST', '/ctrl-int/1/volumedown', '0', '7'],
    ]);
  });

  it('sets position, shuffle and repeat through setproperty', async () => {
    const { client, commands } = await peer(() => ({}));
    await client.setPosition(90.5);
    await client.setShuffle(ShuffleState.Off); await client.setShuffle(ShuffleState.Songs); await client.setShuffle(ShuffleState.Albums);
    await client.setRepeat(RepeatState.Off); await client.setRepeat(RepeatState.Track); await client.setRepeat(RepeatState.All);
    expect(commands().every((s) => s.method === 'POST' && s.url.pathname === '/ctrl-int/1/setproperty' && s.url.searchParams.get('session-id') === '7')).toBe(true);
    expect(commands().map((s) => [...s.url.searchParams].filter(([k]) => k !== 'session-id'))).toEqual([
      [['dacp.playingtime', '90500']],
      [['dacp.shufflestate', '0']], [['dacp.shufflestate', '1']], [['dacp.shufflestate', '1']],
      [['dacp.repeatstate', '0']], [['dacp.repeatstate', '1']], [['dacp.repeatstate', '2']],
    ]);
  });

  it('rejects invalid values before sending', async () => {
    const { client, commands } = await peer(() => ({}));
    for (const value of [-1, Number.NaN, Infinity]) await expect(client.setPosition(value)).rejects.toThrow(/position/i);
    await expect(client.setShuffle(9 as ShuffleState)).rejects.toThrow(/shuffle/i);
    await expect(client.setRepeat(0 as RepeatState)).rejects.toThrow(/repeat/i);
    await expect(client.skipForward(-5)).rejects.toThrow(/skip/i);
    expect(commands()).toHaveLength(0);
  });

  it('simulates skips by reading the position and seeking', async () => {
    // 120 s item with 30 s remaining: position 90 s.
    const { client, commands } = await peer((url) => ({ body: url.pathname.endsWith('playstatusupdate') ? status(30000) : undefined }));
    await client.skipForward(); await client.skipForward(15); await client.skipBackward(); await client.skipBackward(100);
    const seeks = commands().filter((s) => s.url.pathname.endsWith('setproperty')).map((s) => s.url.searchParams.get('dacp.playingtime'));
    expect(seeks).toEqual(['100000', '105000', '80000', '0']);
    expect(commands().filter((s) => s.url.pathname.endsWith('playstatusupdate')).map((s) => s.url.searchParams.get('revision-number'))).toEqual(['0', '0', '0', '0']);
  });

  it('does not seek when the position is unknown', async () => {
    const { client, commands } = await peer((url) => ({ body: url.pathname.endsWith('playstatusupdate') ? status(0xffffffff) : undefined }));
    await client.skipForward();
    expect(commands().map((s) => s.url.pathname)).toEqual(['/ctrl-int/1/playstatusupdate']);
  });
});

describe('DMAP artwork', () => {
  it('requests sized now-playing artwork and returns the raw image', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const { client, commands } = await peer(() => ({ body: png }));
    expect(await client.requestArtwork(200, 100)).toEqual(png);
    const [request] = commands();
    expect([request.method, request.url.pathname, request.url.searchParams.get('mw'), request.url.searchParams.get('mh'), request.url.searchParams.get('session-id')])
      .toEqual(['GET', '/ctrl-int/1/nowplayingartwork', '200', '100', '7']);
  });

  it('returns null when the device has no artwork', async () => {
    const { client } = await peer(() => ({ status: 204 }));
    expect(await client.requestArtwork()).toBeNull();
  });
});

describe('DMAP capabilities', () => {
  it('reports volume from the volume-controllable tag and upstream-supported commands as unknown', async () => {
    let controllable = 1;
    const { client } = await peer(() => ({ body: status(30000, encodeDmap('cavc', u8(controllable))) }));
    expect(client.capabilities().volumeUp).toBe('unknown');
    await client.getState();
    expect(client.capabilities()).toMatchObject({ volumeUp: 'available', volumeDown: 'available' });
    controllable = 0; await client.getState();
    expect(client.capabilities()).toMatchObject({ volumeUp: 'unavailable', volumeDown: 'unavailable' });
    expect(client.capabilities()).toMatchObject({
      setPosition: 'unknown', setShuffle: 'unknown', setRepeat: 'unknown', skipForward: 'unknown', skipBackward: 'unknown', requestArtwork: 'unknown',
      pushUpdates: 'available', setVolume: 'unsupported', keyboard: 'unsupported', apps: 'unsupported', accounts: 'unsupported', power: 'unsupported',
    });
  });
});

describe('DMAP push updates', () => {
  it('long-polls with the server revision without blocking commands', async () => {
    let hold!: () => void;
    const { client, commands } = await peer(async (url) => {
      if (!url.pathname.endsWith('playstatusupdate')) return {};
      const revision = url.searchParams.get('revision-number');
      if (revision === '0') return { body: status(30000, encodeDmap('cmsr', u32(5)), encodeDmap('cann', 'One')) };
      if (revision === '5') return { body: status(20000, encodeDmap('cmsr', u32(6)), encodeDmap('cann', 'Two')) };
      await new Promise<void>((r) => { hold = r; });
      return { body: status(10000, encodeDmap('cmsr', u32(7)), encodeDmap('cann', 'Late')) };
    });
    const updates: NowPlayingInfo[] = [];
    client.on('nowPlaying', (info: NowPlayingInfo) => updates.push(info));
    client.startPushUpdates();
    client.startPushUpdates(); // already active: no second poller
    await expect.poll(() => commands().length).toBe(3);
    expect(updates.map((u) => [u.title, u.elapsedTime])).toEqual([['One', 90], ['Two', 100]]);
    await client.play(); // the pending long-poll uses its own connection
    expect(commands().map((s) => s.url.searchParams.get('revision-number') ?? s.url.pathname)).toEqual(['0', '5', '6', '/ctrl-int/1/play']);
    client.stopPushUpdates();
    hold();
    await new Promise((r) => setTimeout(r, 50));
    expect(updates).toHaveLength(2);
  });

  it('stops and reports an error instead of spinning without a revision', async () => {
    const { client, commands } = await peer(() => ({ body: status(30000) }));
    const errors: Error[] = [];
    const updates: NowPlayingInfo[] = [];
    client.on('nowPlaying', (info: NowPlayingInfo) => updates.push(info));
    client.on('pushError', (error: Error) => errors.push(error));
    client.startPushUpdates();
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0].message).toMatch(/revision/);
    expect(updates).toHaveLength(1);
    expect(commands()).toHaveLength(1);
    client.startPushUpdates(); // restartable after an error
    await expect.poll(() => errors.length).toBe(2);
  });

  it('reports pushError when persistent auth failure closes the client', async () => {
    const { client } = await peer(() => ({ status: 403 }));
    const errors: Error[] = [];
    client.on('pushError', (error: Error) => errors.push(error));
    client.startPushUpdates();
    await expect.poll(() => errors.length).toBe(1);
    expect(errors[0].message).toMatch(/403/);
    expect(() => client.startPushUpdates()).toThrow(/connect/);
  });

  it('requires a connection and stops on close', async () => {
    const unconnected = new DmapClient({ address: '127.0.0.1', dmapPort: 1 });
    expect(() => unconnected.startPushUpdates()).toThrow(/connect/);
    const { client } = await peer(() => new Promise<Reply>(() => {}));
    const errors: Error[] = [];
    client.on('pushError', (error: Error) => errors.push(error));
    client.startPushUpdates();
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).toHaveLength(0);
  });
});
