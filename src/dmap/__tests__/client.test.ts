/** Local HTTP peer tests for DMAP login, recovery, controls and metadata. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DmapClient } from '../client.js';
import { PersistentHttp } from '../../util/http.js';
import { PlaybackState } from '../../now-playing-info.js';

const resources: { server: Server; client: DmapClient }[] = [];
afterEach(async () => { for (const { server, client } of resources.splice(0)) { client.close(); await new Promise<void>((r) => server.close(() => r())); } });
const login = Buffer.from('6d6c6f67000000186d73747400000004000000c86d6c69640000000400000007', 'hex');
async function peer(handler: (url: URL, body: Buffer) => { status?: number; body?: Buffer }) {
  const seen: { url: URL; body: Buffer; method: string; headers: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks); const url = new URL(req.url!, 'http://localhost');
    seen.push({ url, body, method: req.method!, headers: req.headers });
    const reply = handler(url, body); res.writeHead(reply.status ?? 200); res.end(reply.body ?? Buffer.alloc(0));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const client = new DmapClient({ address: '127.0.0.1', dmapPort: (server.address() as AddressInfo).port });
  resources.push({ server, client }); return { client, seen };
}

describe('DMAP session', () => {
  it('rejects modern credentials before opening a connection', async () => {
    const { client, seen } = await peer(() => ({ body: login }));
    await expect(client.connect('{"clientLTSK":"secret"}')).rejects.toThrow(/DMAP/);
    expect(seen).toHaveLength(0);
  });
  it('uses pairing-guid and a single session for commands', async () => {
    const { client, seen } = await peer((url) => ({ body: url.pathname === '/login' ? login : undefined }));
    await client.connect('0x0000000000000001'); await client.play(); await client.select();
    expect(seen[0].url.searchParams.get('pairing-guid')).toBe('0x0000000000000001');
    expect(seen[0].headers['client-daap-version']).toBe('3.13');
    expect(seen[0].headers['x-apple-hkp']).toBeUndefined();
    expect(seen[1].method).toBe('POST'); expect(seen[1].url.pathname).toBe('/ctrl-int/1/play');
    expect(seen[1].url.searchParams.get('session-id')).toBe('7');
    expect(seen[2].body.toString('hex')).toBe('636d62650000000673656c656374636d63630000000100');
  });
  it('uses Home Sharing UUID authentication', async () => {
    const { client, seen } = await peer(() => ({ body: login }));
    await client.connect('11111111-2222-3333-4444-555555555555');
    expect(seen[0].url.searchParams.get('hsgid')).toBe('11111111-2222-3333-4444-555555555555');
  });
  it('relogs once after authorization failure, with a new session', async () => {
    let logins = 0; let commands = 0;
    const { client, seen } = await peer((url) => {
      if (url.pathname === '/login') { const body = Buffer.from(login); body.writeUInt32BE(++logins + 6, body.length - 4); return { body }; }
      return { status: ++commands === 1 ? 403 : 204 };
    });
    await client.connect('0x0000000000000001'); await client.pause();
    expect(seen.map((s) => s.url.searchParams.get('session-id'))).toEqual([null, '7', null, '8']);
  });
  it('does not replay unsupported commands or loop on persistent auth failure', async () => {
    const { client, seen } = await peer((url) => ({ body: url.pathname === '/login' ? login : undefined, status: url.pathname === '/login' ? 200 : 500 }));
    await client.connect('0x0000000000000001'); await expect(client.play()).rejects.toThrow(/500/); expect(seen).toHaveLength(2);
  });
  it('rejects missing login session and commands after close', async () => {
    const { client } = await peer(() => ({ body: Buffer.from('6d6c6f6700000000', 'hex') }));
    await expect(client.connect('0x0000000000000001')).rejects.toThrow(/session/i);
    client.close(); await expect(client.play()).rejects.toThrow(/connect/i);
  });
  it('maps unsigned millisecond metadata and playback state', async () => {
    // cmst: mstt=200, caps=4, cast=120000, cant=30000, cann=Test, cana=Artist.
    const fixture = Buffer.from('636d7374000000476d73747400000004000000c863617073000000010463617374000000040001d4c063616e74000000040000753063616e6e000000045465737463616e6100000006417274697374', 'hex');
    const { client, seen } = await peer((url) => ({ body: url.pathname === '/login' ? login : fixture }));
    await client.connect('0x0000000000000001'); const state = await client.getState();
    expect(state.title).toBe('Test'); expect(state.artist).toBe('Artist'); expect(state.duration).toBe(120); expect(state.elapsedTime).toBe(90); expect(state.playbackState).toBe(PlaybackState.Playing);
    expect(seen[1].url.searchParams.get('revision-number')).toBe('0');
    expect(client.capabilities().play).toBe('unknown'); expect(client.capabilities().apps).toBe('unsupported');
  });
});


it('sends every implemented command and literal touch trajectories', async () => {
  const { client, seen } = await peer((url) => ({ body: url.pathname === '/login' ? login : undefined }));
  await client.connect('0x0000000000000001');
  await client.playPause(); await client.stop(); await client.next(); await client.previous(); await client.menu(); await client.topMenu();
  expect(seen.slice(1).map((s) => s.url.pathname)).toEqual(['/ctrl-int/1/playpause', '/ctrl-int/1/stop', '/ctrl-int/1/nextitem', '/ctrl-int/1/previtem', '/ctrl-int/1/controlpromptentry', '/ctrl-int/1/controlpromptentry']);
  expect(seen[5].body.toString('hex')).toBe('636d6265000000046d656e75636d63630000000100');
  for (const [method, first, last] of [
    ['up', 'touchDown&time=0&point=20,275', 'touchUp&time=6&point=20,250'],
    ['down', 'touchDown&time=0&point=20,250', 'touchUp&time=6&point=20,275'],
    ['left', 'touchDown&time=0&point=75,100', 'touchUp&time=7&point=50,100'],
    ['right', 'touchDown&time=0&point=50,100', 'touchUp&time=7&point=75,100'],
  ] as const) {
    const start = seen.length; await client[method]();
    expect(seen.length - start).toBe(7);
    expect(seen[start].body.subarray(0, 9).toString('hex')).toBe('636d63630000000130');
    expect(seen[start].body.subarray(17).toString()).toBe(first);
    expect(seen.at(-1)!.body.subarray(17).toString()).toBe(last);
  }
});

it('bounds persistent auth failures and clears the failed session', async () => {
  const { client, seen } = await peer((url) => ({ body: url.pathname === '/login' ? login : undefined, status: url.pathname === '/login' ? 200 : 401 }));
  await client.connect('0x0000000000000001'); await expect(client.play()).rejects.toThrow(/401/);
  expect(seen).toHaveLength(4); await expect(client.play()).rejects.toThrow(/connected/); expect(seen).toHaveLength(4);
});

for (const [wire, expected] of [[0, PlaybackState.Stopped], [1, PlaybackState.Unknown], [2, PlaybackState.Stopped], [3, PlaybackState.Paused], [5, PlaybackState.Seeking], [6, PlaybackState.Seeking], [255, PlaybackState.Unknown]]) {
  it(`maps legacy play state ${wire} without inventing metadata`, async () => {
    const fixture = Buffer.from('636d7374000000216d73747400000004000000c863617073000000010063616e7400000004ffffffff', 'hex');
    fixture[28] = wire;
    const { client } = await peer((url) => ({ body: url.pathname === '/login' ? login : fixture }));
    await client.connect('0x0000000000000001'); const state = await client.getState();
    expect(state.playbackState).toBe(expected); expect(state.elapsedTime).toBe(0); expect(state.title).toBe('');
    expect(client.capabilities().title).toBe('unknown');
  });
}

it('does not let an old failed connect close a newer session', async () => {
  const { client } = await peer(() => ({ body: login }));
  let fail!: (error: Error) => void;
  const spy = vi.spyOn(PersistentHttp.prototype, 'request').mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const old = client.connect('0x0000000000000001');
  client.close(); await client.connect('0x0000000000000002');
  fail(new Error('old socket closed')); await expect(old).rejects.toThrow();
  spy.mockRestore(); await expect(client.play()).resolves.toBeUndefined();
});

it('waits for an in-flight relogin before allowing a concurrent command', async () => {
  const { client } = await peer(() => ({ body: login }));
  await client.connect('0x0000000000000001');
  let finishLogin!: (reply: { status: number; body: Buffer }) => void;
  const request = vi.spyOn(PersistentHttp.prototype, 'request')
    .mockResolvedValueOnce({ status: 403, body: Buffer.alloc(0) })
    .mockImplementationOnce(() => new Promise(resolve => { finishLogin = resolve; }))
    .mockResolvedValue({ status: 204, body: Buffer.alloc(0) });
  const first = client.play();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const second = client.pause();
  const assertion = expect(second).resolves.toBeUndefined();
  finishLogin({ status: 200, body: login });
  try { await first; await assertion; expect(request).toHaveBeenCalledTimes(4); }
  finally { request.mockRestore(); }
});

it('releases a failed DMAP touch sequence and preserves the original error', async () => {
  const touches: string[] = [];
  const { client } = await peer((url, body) => {
    if (url.pathname === '/login') return { body: login };
    const touch = body.subarray(17).toString(); touches.push(touch);
    return { status: touch.startsWith('touchMove') ? 500 : 204 };
  });
  await client.connect('0x0000000000000001');
  await expect(client.up()).rejects.toThrow(/500/);
  expect(touches.at(-1)).toBe('touchUp&time=6&point=20,250');
});
