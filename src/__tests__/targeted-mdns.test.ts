import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePacket, parseTargets, TargetedMdns, type TargetedService } from '../targeted-mdns.js';

const sockets: dgram.Socket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

const name = (value: string) => Buffer.concat([...value.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
const rr = (owner: string, type: number, data: Buffer, ttl = 120, flush = false, klass = 1) => {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0); header.writeUInt16BE(klass | (flush ? 0x8000 : 0), 2); header.writeUInt32BE(ttl, 4); header.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), header, data]);
};
const packet = (...records: Buffer[]) => {
  const header = Buffer.alloc(12); header.writeUInt16BE(0x8400, 2); header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
};

async function bind(address: string) {
  const socket = dgram.createSocket('udp4');
  sockets.push(socket);
  const port = await new Promise<number>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, address, () => {
      const binding = socket.address();
      if (typeof binding === 'string') { reject(new Error('Expected a UDP address')); return; }
      resolve(binding.port);
    });
  });
  return { socket, port };
}

describe('targeted mDNS', () => {
  it('validates literals and requires a link-local IPv6 scope', () => {
    expect(parseTargets(['192.0.2.7', '2001:db8::7%en0'])).toEqual([
      { address: '192.0.2.7', family: 4, scope: undefined, canonical: '192.0.2.7' },
      { address: '2001:db8::7%en0', family: 6, scope: 'en0', canonical: '2001:db8::7' },
    ]);
    expect(() => parseTargets(['', 'host.example', 'fe80::1'])).toThrow('Invalid discovery host: ');
    expect(() => parseTargets(['fe80::1'])).toThrow('requires a scope');
  });

  it('decodes complete DNS answer sections', () => {
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    expect(parsePacket(packet(
      rr('_airplay._tcp.local', 12, name(instance)),
      rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
      rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
      rr(host, 1, Buffer.from([192, 0, 2, 44])),
    ))).toHaveLength(4);
  });

  it('retains TTL and cache-flush metadata while discarding unavailable root targets', () => {
    const records = parsePacket(packet(
      rr('_airplay._tcp.local', 12, Buffer.from([0]), 0),
      rr('living-room.local', 1, Buffer.from([192, 0, 2, 44]), 30, true),
    ));
    expect(records).toEqual([expect.objectContaining({ type: 1, ttl: 30, flush: true, data: '192.0.2.44' })]);
  });

  it('ignores malformed records without losing later records in the datagram', () => {
    expect(parsePacket(packet(
      rr('living-room._airplay._tcp.local', 16, Buffer.from([4, 0x61])),
      rr('living-room.local', 1, Buffer.from([192, 0, 2, 44])),
    ))).toEqual([expect.objectContaining({ type: 1, data: '192.0.2.44' })]);
  });

  it('skips non-IN records without discarding valid answers around them', () => {
    expect(parsePacket(packet(
      rr('living-room.local', 1, Buffer.from([192, 0, 2, 44])),
      rr('ignored.local', 41, Buffer.alloc(0), 0, false, 1_232),
      rr('living-room.local', 28, Buffer.from('20010db8000000000000000000000044', 'hex')),
    )).map(record => record.data)).toEqual(['192.0.2.44', '2001:db8:0:0:0:0:0:44']);
  });

  // The second case keeps the advertised instance name's case while matching owners case-insensitively.
  it.each([
    { instance: 'living-room._airplay._tcp.local', owner: 'living-room._airplay._tcp.local', host: 'living-room.local', shown: 'living-room' },
    { instance: 'Living Room._airplay._tcp.local', owner: 'living room._airplay._tcp.local', host: 'Living-Room.local', shown: 'Living Room' },
  ])('follows PTR records to assemble SRV, TXT and A answers while suppressing duplicates ($shown)', async ({ instance, owner, host, shown }) => {
    const { socket: responder, port } = await bind('127.0.0.1');
    let answered = false;
    const changed = deferred<TargetedService>();
    responder.on('message', (requestPacket, rinfo) => {
      const named = /iving.room/i.test(requestPacket.toString('latin1'));
      if (named && answered) return;
      if (named) answered = true;
      const response = named ? packet(
        rr(owner, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
        rr(owner, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
        rr(host.toLowerCase(), 1, Buffer.from([192, 0, 2, 44])),
      ) : packet(rr('_airplay._tcp.local', 12, name(instance)));
      responder.send(response, rinfo.port, rinfo.address);
      responder.send(response, rinfo.port, rinfo.address);
      if (named) responder.send(packet(rr(owner, 16, Buffer.concat([
        Buffer.from([17]), Buffer.from('deviceid=11:22:33'), Buffer.from([6]), Buffer.from('done=1'),
      ]))), rinfo.port, rinfo.address);
    });
    const services: TargetedService[] = [];
    const resolver = new TargetedMdns(parseTargets(['127.0.0.1']), service => {
      services.push(service);
      if (service.txt.done === '1') changed.resolve(service);
    }, error => { throw error; }, port, 0);
    try {
      await resolver.start();
      // The genuine TXT change is a wire barrier after the duplicate datagrams, not a sleep.
      await changed.promise;
      expect(services).toEqual([
        expect.objectContaining({ type: 'airplay', name: shown, host: host.toLowerCase(), port: 7000, addresses: ['192.0.2.44'], txt: { deviceid: '11:22:33' } }),
        expect.objectContaining({ addresses: ['192.0.2.44'], txt: { deviceid: '11:22:33', done: '1' } }),
      ]);
    } finally { resolver.close(); }
  });

  it('accepts an IPv4 multicast reply on the selected loopback interface', async () => {
    const { socket: responder, port } = await bind('127.0.0.1');
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    const received = deferred<TargetedService>();
    let replied = false;
    responder.on('message', (_request, rinfo) => {
      if (replied) return;
      replied = true;
      responder.setMulticastInterface('127.0.0.1');
      responder.send(packet(
        rr('_airplay._tcp.local', 12, name(instance)),
        rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
        rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
        rr(host, 1, Buffer.from([192, 0, 2, 44])),
      ), 5353, '224.0.0.251');
    });
    const resolver = new TargetedMdns(parseTargets(['127.0.0.1']), received.resolve, error => { throw error; }, port, 0, Date.now, '127.0.0.1');
    try {
      await resolver.start();
      await expect(received.promise).resolves.toMatchObject({ host, addresses: ['192.0.2.44'] });
    } finally {
      resolver.close();
    }
  });

  it('retains recent cache-flush siblings and expires older RRset members after grace', async () => {
    const { socket: responder, port } = await bind('127.0.0.1');
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    const phaseValue = Buffer.from('deviceid=11:22:33;phase=3');
    let now = 0;
    const initial = deferred<void>();
    const flushed = deferred<void>();
    const phase3 = deferred<void>();
    const pruned = deferred<void>();
    let recipient: dgram.RemoteInfo | undefined;
    responder.on('message', (_request, rinfo) => {
      if (recipient) return;
      recipient = rinfo;
      responder.send(packet(
        rr('_airplay._tcp.local', 12, name(instance)),
        rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
        rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
        rr(host, 1, Buffer.from([192, 0, 2, 40])),
        rr(host, 28, Buffer.from('20010db8000000000000000000000040', 'hex')),
      ), rinfo.port, rinfo.address);
    });
    const services: TargetedService[] = [];
    const resolver = new TargetedMdns(parseTargets(['127.0.0.1']), service => {
      services.push(service);
      if (now === 0) initial.resolve();
      else if (now === 500) flushed.resolve();
      else if (now === 1_501) phase3.resolve();
      else if (now === 2_502) pruned.resolve();
    }, error => { throw error; }, port, 0, () => now);
    try {
      await resolver.start();
      await initial.promise;
      if (!recipient) throw new Error('Responder did not receive a query');
      now = 500;
      responder.send(packet(
        rr(host, 1, Buffer.from([192, 0, 2, 41]), 120, true),
        rr(host, 1, Buffer.from([192, 0, 2, 42]), 120, true),
        rr(host, 28, Buffer.from('20010db8000000000000000000000041', 'hex'), 120, true),
      ), recipient.port, recipient.address);
      await flushed.promise;
      expect(services.at(-1)?.addresses).toEqual(['192.0.2.40', '192.0.2.41', '192.0.2.42', '2001:db8:0:0:0:0:0:40', '2001:db8:0:0:0:0:0:41']);
      now = 1_501;
      responder.send(packet(
        rr(host, 1, Buffer.from([192, 0, 2, 41]), 120, true),
        rr(instance, 16, Buffer.concat([Buffer.from([phaseValue.length]), phaseValue]), 120),
      ), recipient.port, recipient.address);
      await phase3.promise;
      expect(services.at(-1)?.addresses).toEqual(['192.0.2.40', '192.0.2.41', '192.0.2.42', '2001:db8:0:0:0:0:0:40', '2001:db8:0:0:0:0:0:41']);
      now = 2_502;
      responder.send(packet(), recipient.port, recipient.address);
      await pruned.promise;
      expect(services.at(-1)?.addresses).toEqual(['192.0.2.41', '2001:db8:0:0:0:0:0:40', '2001:db8:0:0:0:0:0:41']);
    } finally {
      resolver.close();
    }
  });

  it('refreshes and processes goodbyes when the cache is full', async () => {
    const { socket: responder, port } = await bind('127.0.0.1');
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    const addresses = Array.from({ length: 125 }, (_, index) => rr(host, 1, Buffer.from([10, 0, 0, index + 1])));
    const phaseValue = Buffer.from('deviceid=11:22:33;phase=goodbye');
    let now = 0;
    let recipient: dgram.RemoteInfo | undefined;
    responder.on('message', (_request, rinfo) => {
      if (recipient) return;
      recipient = rinfo;
      responder.send(packet(
        rr('_airplay._tcp.local', 12, name(instance)),
        rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
        rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
        ...addresses,
      ), rinfo.port, rinfo.address);
    });
    const initial = deferred<void>();
    const goodbye = deferred<void>();
    const refreshed = deferred<void>();
    const resolver = new TargetedMdns(parseTargets(['127.0.0.1']), service => {
      if (now === 0) initial.resolve();
      else if (now === 1_001) goodbye.resolve();
      else if (now === 2_002 && service.addresses.includes('10.0.1.1')) {
        expect(service.addresses).not.toContain('10.0.0.1');
        refreshed.resolve();
      }
    }, error => { throw error; }, port, 0, () => now);
    try {
      await resolver.start();
      await initial.promise;
      if (!recipient) throw new Error('Responder did not receive a query');
      now = 1_001;
      responder.send(packet(
        rr(host, 1, Buffer.from([10, 0, 0, 1]), 0),
        rr(instance, 16, Buffer.concat([Buffer.from([phaseValue.length]), phaseValue])),
      ), recipient.port, recipient.address);
      await goodbye.promise;
      now = 2_002;
      responder.send(packet(rr(host, 1, Buffer.from([10, 0, 1, 1]))), recipient.port, recipient.address);
      await refreshed.promise;
    } finally {
      resolver.close();
    }
  });

  it('does not assemble late records after a required record expires', async () => {
    const { socket: responder, port } = await bind('127.0.0.1');
    const instance = 'living-room._airplay._tcp.local';
    const host = 'living-room.local';
    let now = 0;
    let ptrSent = false;
    let lateReplySent = false;
    const processed = deferred<void>();
    responder.on('message', (request, rinfo) => {
      const requested = request.toString('latin1');
      if (!ptrSent && requested.includes('airplay')) {
        ptrSent = true;
        responder.send(packet(rr('_airplay._tcp.local', 12, name(instance), 1)), rinfo.port, rinfo.address);
      } else if (!lateReplySent && /iving.room/i.test(requested)) {
        lateReplySent = true;
        now = 1_001;
        responder.send(packet(
          rr(instance, 33, Buffer.concat([Buffer.from([0, 0, 0, 0x00, 0x1b, 0x58]), name(host)])),
          rr(instance, 16, Buffer.concat([Buffer.from([17]), Buffer.from('deviceid=11:22:33')])),
          rr(host, 1, Buffer.from([192, 0, 2, 44])),
        ), rinfo.port, rinfo.address);
      } else if (lateReplySent && !requested.includes('airplay') && requested.includes('living-room')) {
        processed.resolve();
      }
    });
    const services: TargetedService[] = [];
    const resolver = new TargetedMdns(parseTargets(['127.0.0.1']), service => services.push(service), error => { throw error; }, port, 0, () => now);
    await resolver.start();
    await processed.promise;
    resolver.close();
    expect(services).toEqual([]);
  });
});
