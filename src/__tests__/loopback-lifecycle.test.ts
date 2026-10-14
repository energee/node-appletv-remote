/** Real local TCP transport loss during pair-verify; never contacts an Apple TV. */
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { AirPlayConnection } from '../connection.js';
import { CompanionConnection } from '../companion/connection.js';
const credentials = { clientId: 'test', serverId: 'server', clientLTSK: Buffer.alloc(32), clientLTPK: Buffer.alloc(32), serverLTPK: Buffer.alloc(32) };
it.each([['AirPlay', AirPlayConnection], ['Companion', CompanionConnection]] as const)('%s rejects setup on real peer disconnect and can retry explicitly', async (_name, Connection) => {
  const peers = new Set<Socket>();
  let requests = 0;
  const server = createServer(peer => {
    peers.add(peer);
    peer.once('close', () => peers.delete(peer));
    peer.once('data', () => { requests++; peer.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback port');
  const conn = new Connection('127.0.0.1', address.port, credentials);
  let closes = 0;
  conn.on('close', () => { closes++; });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(conn.connect()).rejects.toThrow(/closed/i);
      conn.close();
    }
    expect(requests).toBe(2);
    expect(closes).toBe(2);
  } finally {
    conn.close();
    for (const peer of peers) peer.destroy();
    server.close();
    await once(server, 'close');
  }
});
