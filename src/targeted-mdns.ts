import dgram from 'node:dgram';
import { isIP } from 'node:net';

export const SERVICE_TYPES = ['airplay', 'raop', 'companion-link', 'mediaremotetv', 'touch-able', 'appletv-v2'] as const;
type ServiceType = typeof SERVICE_TYPES[number];
const SERVICE_NAMES: Record<ServiceType, string> = { airplay: '_airplay._tcp.local', raop: '_raop._tcp.local', 'companion-link': '_companion-link._tcp.local', mediaremotetv: '_mediaremotetv._tcp.local', 'touch-able': '_touch-able._tcp.local', 'appletv-v2': '_appletv-v2._tcp.local' };
const MAX_RECORDS = 128;
const MAX_NAME_BYTES = 255;

export interface TargetedService { type: ServiceType; name: string; host: string; port: number; addresses: string[]; txt: Record<string, string>; fqdn: string; }
export interface Target { address: string; family: 4 | 6; scope?: string; canonical: string; }
export type Resource = { name: string; type: number; ttl: number; flush: boolean; data: string | { host: string; port: number } | Record<string, string> };
type Cache = { ptrs: Map<string, Set<string>>; srvs: Map<string, { host: string; port: number }>; txts: Map<string, Record<string, string>>; addresses: Map<string, Set<string>>; emitted: Set<string>; queries: Set<string>; records: number };
type State = { target: Target; querySocket: dgram.Socket; listener?: dgram.Socket; cache: Cache };

const canonicalAddress = (address: string) => isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;

/** Validate literal mDNS targets before any socket is opened. */
export function parseTargets(hosts: readonly string[]): Target[] {
  return hosts.map((host) => {
    if (!host || !host.trim() || host !== host.trim()) throw new Error(`Invalid discovery host: ${host}`);
    const [address, ...parts] = host.split('%');
    const scope = parts.length ? parts.join('%') : undefined;
    const family = isIP(address);
    if ((family !== 4 && family !== 6) || (family === 4 && scope) || parts.length > 1 || (parts.length && !scope)) throw new Error(`Invalid discovery host: ${host}`);
    if (family === 6 && /^fe[89ab]/i.test(address) && !scope) throw new Error(`IPv6 link-local discovery host requires a scope: ${host}`);
    return { address: host, family: family as 4 | 6, scope, canonical: canonicalAddress(address) };
  });
}

const writeName = (name: string): Buffer => {
  const labels = name.replace(/\.$/, '').split('.');
  if (!name || Buffer.byteLength(name) > MAX_NAME_BYTES || labels.some(label => !label || Buffer.byteLength(label) > 63)) throw new Error(`Invalid DNS name: ${name}`);
  return Buffer.concat([...labels.map(label => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
};
const query = (name: string, type: number): Buffer => { const header = Buffer.alloc(12); header.writeUInt16BE(1, 4); return Buffer.concat([header, writeName(name), Buffer.from([type >> 8, type & 0xff, 0x80, 1])]); };
function readName(packet: Buffer, offset: number, seen = new Set<number>()): [string, number] | undefined {
  const labels: string[] = []; let next = offset; let jumped = false;
  while (offset < packet.length) {
    const length = packet[offset++];
    if ((length & 0xc0) === 0xc0) { if (offset >= packet.length) return; const pointer = ((length & 0x3f) << 8) | packet[offset++]; if (pointer >= packet.length || seen.has(pointer)) return; seen.add(pointer); const pointed = readName(packet, pointer, seen); if (!pointed) return; labels.push(pointed[0]); if (!jumped) next = offset; jumped = true; break; }
    if (length & 0xc0 || length > 63 || offset + length > packet.length) return;
    if (!length) { if (!jumped) next = offset; break; }
    labels.push(packet.subarray(offset, offset + length).toString('utf8')); offset += length;
  }
  const name = labels.join('.');
  return Buffer.byteLength(name) <= MAX_NAME_BYTES ? [name, next] : undefined;
}

export function parsePacket(packet: Buffer): Resource[] {
  if (packet.length < 12) return [];
  const questions = packet.readUInt16BE(4); const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (questions > 64 || count > MAX_RECORDS) return [];
  let offset = 12;
  for (let index = 0; index < questions; index++) { const name = readName(packet, offset); if (!name || name[1] + 4 > packet.length) return []; offset = name[1] + 4; }
  const records: Resource[] = [];
  for (let index = 0; index < count; index++) {
    const name = readName(packet, offset); if (!name || name[1] + 10 > packet.length) return [];
    const type = packet.readUInt16BE(name[1]); const klass = packet.readUInt16BE(name[1] + 2); const ttl = packet.readUInt32BE(name[1] + 4); const length = packet.readUInt16BE(name[1] + 8); const start = name[1] + 10; const end = start + length;
    if (end > packet.length || (klass & 0x7fff) !== 1) return [];
    let data: Resource['data'] | undefined;
    if (type === 12) { const value = readName(packet, start); if (value && value[1] <= end && value[0]) data = value[0]; }
    else if (type === 33 && length >= 6) { const host = readName(packet, start + 6); if (host && host[1] <= end && host[0]) data = { port: packet.readUInt16BE(start + 4), host: host[0].toLowerCase() }; }
    else if (type === 1 && length === 4) data = Array.from(packet.subarray(start, end)).join('.');
    else if (type === 28 && length === 16) { const parts: string[] = []; for (let part = start; part < end; part += 2) parts.push(packet.readUInt16BE(part).toString(16)); data = parts.join(':'); }
    else if (type === 16) { const txt: Record<string, string> = {}; let cursor = start; let valid = true; while (cursor < end) { const size = packet[cursor++]; if (cursor + size > end) { valid = false; break; } const entry = packet.subarray(cursor, cursor + size).toString('utf8'); const equals = entry.indexOf('='); const key = (equals < 0 ? entry : entry.slice(0, equals)).toLowerCase(); if (key) txt[key] = equals < 0 ? '' : entry.slice(equals + 1); cursor += size; } if (valid) data = txt; }
    // Owner names and SRV hosts are lowercased lookup keys; a PTR target keeps its case for display.
    if (data !== undefined) records.push({ name: name[0].toLowerCase(), type, ttl, flush: Boolean(klass & 0x8000), data }); offset = end;
  }
  return records;
}
const isSrv = (data: Resource['data']): data is { host: string; port: number } => typeof data === 'object' && 'host' in data && typeof data.host === 'string' && 'port' in data && typeof data.port === 'number';
const newCache = (): Cache => ({ ptrs: new Map(), srvs: new Map(), txts: new Map(), addresses: new Map(), emitted: new Set(), queries: new Set(), records: 0 });

/** Deliberately low-level targeted mDNS/DNS-SD transport; Bonjour remains for ordinary browsing. */
export class TargetedMdns {
  private readonly states: State[] = [];
  private retry: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(private readonly targets: Target[], private readonly found: (service: TargetedService) => void, private readonly fail: (error: Error) => void, private readonly port = 5353, private readonly bindPort = 0) {}
  async start(): Promise<void> {
    if (this.closed) return;
    await Promise.all(this.targets.map(target => this.open(target)));
    if (this.closed) return;
    this.sendQuestions();
    this.retry = setInterval(() => this.sendQuestions(), 750);
  }
  close(): void { if (this.closed) return; this.closed = true; clearInterval(this.retry); for (const state of this.states) { state.querySocket.close(); state.listener?.close(); } }
  private open(target: Target): Promise<void> {
    return new Promise((resolve, reject) => {
      const querySocket = dgram.createSocket({ type: target.family === 4 ? 'udp4' : 'udp6', reuseAddr: true }); const state: State = { target, querySocket, cache: newCache() }; this.states.push(state);
      const fail = (error: Error) => { if (!this.closed) this.close(); reject(error); };
      querySocket.once('close', resolve);
      querySocket.once('error', fail); querySocket.on('message', (packet, rinfo) => this.receive(packet, state, rinfo.address));
      querySocket.bind(this.bindPort, () => {
        if (this.closed) { resolve(); return; }
        querySocket.off('error', fail);
        querySocket.on('error', error => this.fail(error));
        this.openListener(state, resolve, reject);
      });
    });
  }
  private openListener(state: State, resolve: () => void, reject: (error: Error) => void): void {
    const listener = dgram.createSocket({ type: state.target.family === 4 ? 'udp4' : 'udp6', reuseAddr: true }); state.listener = listener;
    listener.once('close', resolve);
    listener.once('error', reject); listener.on('message', (packet, rinfo) => this.receive(packet, state, rinfo.address));
    listener.bind(5353, () => {
      if (this.closed) { resolve(); return; }
      try {
        listener.addMembership(state.target.family === 4 ? '224.0.0.251' : 'ff02::fb', state.target.family === 6 ? state.target.scope : undefined);
        listener.off('error', reject);
        listener.on('error', error => this.fail(error));
        resolve();
      } catch (error) { reject(error as Error); }
    });
  }
  private sendQuestions(): void { if (this.closed) return; for (const state of this.states) { state.cache.queries.clear(); for (const type of SERVICE_TYPES) this.ask(state, SERVICE_NAMES[type], 12); for (const instances of state.cache.ptrs.values()) for (const instance of instances) { this.ask(state, instance, 33); this.ask(state, instance, 16); } for (const srv of state.cache.srvs.values()) { this.ask(state, srv.host, 1); this.ask(state, srv.host, 28); } } }
  private ask(state: State, name: string, type: number): void { if (!name || state.cache.queries.size >= MAX_RECORDS) return; const key = `${name}/${type}`; if (state.cache.queries.has(key)) return; state.cache.queries.add(key); let packet: Buffer; try { packet = query(name, type); } catch { return; } state.querySocket.send(packet, this.port, state.target.address, error => { if (error && !this.closed) this.fail(error); }); }
  private receive(packet: Buffer, state: State, source: string): void {
    if (canonicalAddress(source) !== state.target.canonical) return;
    for (const record of parsePacket(packet)) { if (state.cache.records >= MAX_RECORDS) break; this.store(state, record); }
    this.emit(state);
  }
  private store(state: State, record: Resource): void {
    const cache = state.cache;
    if (record.type === 12 && typeof record.data === 'string' && Object.values(SERVICE_NAMES).includes(record.name)) { const values = cache.ptrs.get(record.name) ?? new Set<string>(); if (record.ttl === 0) values.delete(record.data); else if (values.size < MAX_RECORDS) values.add(record.data); if (values.size) cache.ptrs.set(record.name, values); else cache.ptrs.delete(record.name); if (record.ttl) { this.ask(state, record.data, 33); this.ask(state, record.data, 16); } }
    else if (record.type === 33 && isSrv(record.data)) { if (record.ttl === 0) cache.srvs.delete(record.name); else { cache.srvs.set(record.name, record.data); this.ask(state, record.data.host, 1); this.ask(state, record.data.host, 28); } }
    else if (record.type === 16 && typeof record.data === 'object' && !isSrv(record.data)) { if (record.ttl === 0) cache.txts.delete(record.name); else cache.txts.set(record.name, record.data); }
    else if ((record.type === 1 || record.type === 28) && typeof record.data === 'string') { const value = record.type === 28 && /^fe[89ab]/i.test(record.data) && state.target.scope ? `${record.data}%${state.target.scope}` : record.data; const values = record.flush ? new Set<string>() : cache.addresses.get(record.name) ?? new Set<string>(); if (record.ttl === 0) values.delete(value); else if (values.size < MAX_RECORDS) values.add(value); if (values.size) cache.addresses.set(record.name, values); else cache.addresses.delete(record.name); }
    cache.records = cache.ptrs.size + cache.srvs.size + cache.txts.size + cache.addresses.size;
  }
  private emit(state: State): void { for (const type of SERVICE_TYPES) for (const instance of state.cache.ptrs.get(SERVICE_NAMES[type]) ?? []) { const lookup = instance.toLowerCase(); const srv = state.cache.srvs.get(lookup); const addresses = srv ? [...(state.cache.addresses.get(srv.host) ?? [])] : []; if (!srv || !state.cache.txts.has(lookup) || !addresses.length) continue; const service = { type, name: instance.replace(new RegExp(`\\.${SERVICE_NAMES[type]}$`, 'i'), ''), host: srv.host, port: srv.port, addresses, txt: state.cache.txts.get(lookup)!, fqdn: instance }; const key = JSON.stringify(service); if (state.cache.emitted.has(key)) continue; state.cache.emitted.add(key); this.found(service); } }
}
