/** Reverse DMAP pairing: advertise a Remote server and validate the TV callback. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isIPv4, type AddressInfo } from 'node:net';
import { Bonjour, type Service } from 'bonjour-service';
import { encodeDmap } from './codec.js';

/** address is this controller's local IPv4 interface, NOT the Apple TV's address. */
export interface DmapPairingOptions { name: string; address: string; pin: string; guid?: string }

/** Start, enter this controller's PIN on the TV, finish after the callback, then always close. */
export class DmapPairing {
  private guid: string;
  private server?: Server;
  private starting = false;
  private bonjour?: Bonjour;
  private service?: Service;
  private paired = false;
  private failures = 0;
  private deadline = 0;
  constructor(private options: DmapPairingOptions) {
    if (!/^\d{4}$/.test(options.pin)) throw new Error('DMAP PIN must be four digits');
    if (!isIPv4(options.address)) throw new Error('Pairing requires a local IPv4 address');
    if (options.guid && !/^0x[0-9a-fA-F]{16}$/.test(options.guid)) throw new Error('Invalid DMAP pairing GUID');
    this.guid = (options.guid?.slice(2) ?? randomBytes(8).toString('hex')).toUpperCase();
  }

  /** Legacy wire challenge (MD5 is mandated by DMAP, not modern authentication). */
  pairingCode(): string {
    return createHash('md5').update(this.guid + [...this.options.pin].map((char) => char + '\0').join('')).digest('hex');
  }

  /** Bind the chosen local interface and advertise _touch-remote._tcp; close cancels pending startup. */
  async start(): Promise<void> {
    if (this.server || this.starting) throw new Error('DMAP pairing already started');
    this.starting = true;
    this.paired = false; this.failures = 0; this.deadline = Date.now() + 300_000;
    this.server = createServer((req, res) => {
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://localhost'); }
      catch { res.writeHead(400).end(); return; }
      if (req.method !== 'GET' || url.pathname !== '/pair') { res.writeHead(404).end(); return; }
      if (this.paired) { res.writeHead(409).end(); return; }
      if (this.failures >= 5 || Date.now() > this.deadline) { res.writeHead(429).end(); return; }
      const code = url.searchParams.get('pairingcode') ?? '';
      if (!url.searchParams.get('servicename') || !/^[0-9a-fA-F]{32}$/.test(code) || !timingSafeEqual(Buffer.from(code.toLowerCase()), Buffer.from(this.pairingCode()))) {
        this.failures++; res.writeHead(500).end(); return;
      }
      const guid = Buffer.alloc(8); guid.writeBigUInt64BE(BigInt('0x' + this.guid));
      const body = encodeDmap('cmpa', Buffer.concat([encodeDmap('cmpg', guid), encodeDmap('cmnm', this.options.name), encodeDmap('cmty', 'iPhone')]));
      res.writeHead(200, { 'Content-Type': 'application/x-dmap-tagged' }).end(body);
      this.paired = true;
    });
    const server = this.server;
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { server.removeListener('error', error); server.removeListener('close', closed); };
        const error = (cause: Error) => { cleanup(); reject(cause); };
        const closed = () => error(new Error('DMAP pairing was closed during startup'));
        server.once('error', error); server.once('close', closed);
        server.listen(0, this.options.address, () => { cleanup(); resolve(); });
      });
      if (this.server !== server) throw new Error('DMAP pairing was closed during startup');
      this.bonjour = new Bonjour();
      const name = String(this.options.address.split('.').reduce((value, byte) => value * 256 + Number(byte), 0)).padStart(40, '0');
      this.service = this.bonjour.publish({ name, type: 'touch-remote', protocol: 'tcp', disableIPv6: true, host: `node-remote-${this.guid.toLowerCase()}.local`, port: (this.server.address() as AddressInfo).port,
        txt: { DvNm: this.options.name, RemV: '10000', DvTy: 'iPod', RemN: 'Remote', txtvers: '1', Pair: this.guid } });
      // Bonjour normally advertises every interface; only this bound IPv4 accepts callbacks.
      const service = this.service;
      const records = service.records.bind(service);
      service.records = () => [...records().filter((record) => record.type !== 'A' && record.type !== 'AAAA'),
        { name: service.host, type: 'A', ttl: 120, data: this.options.address }];
    } catch (error) { if (this.server === server) await this.close(); throw error; }
    finally { this.starting = false; }
  }

  /**
   * Return the legacy GUID only after a verified callback (does not close the server).
   * @throws "DMAP remote is not paired" while waiting; a distinct error once five wrong PINs locked
   * pairing or the five-minute window expired, since neither can still succeed.
   */
  finish(): string {
    if (!this.paired) {
      if (this.failures >= 5) throw new Error('DMAP pairing locked after five wrong PINs; restart pairing');
      if (this.deadline && Date.now() > this.deadline) throw new Error('DMAP pairing expired after five minutes; restart pairing');
      throw new Error('DMAP remote is not paired');
    }
    return '0x' + this.guid;
  }

  /** Unpublish and release all sockets; idempotent and safe after failed startup. */
  async close(): Promise<void> {
    this.service?.stop?.(); this.service = undefined;
    this.bonjour?.destroy(); this.bonjour = undefined;
    const server = this.server; this.server = undefined; this.paired = false;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
