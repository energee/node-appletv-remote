/**
 * Optional versioned credential storage. Plaintext FileStorage is not a keychain:
 * protect its directory and use a platform secret store through StorageAdapter when needed.
 * A storage instance is owned by its caller; updates remain in memory until save().
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { HAPCredentials } from './auth/types.js';

export const STORAGE_VERSION = 1;
export type Protocol = 'airplay' | 'mrp' | 'companion' | 'raop' | 'dmap';
type EncodedHap = { clientId: string; clientLTSK: string; clientLTPK: string; serverLTPK: string; serverId: string };
export type ProtocolCredentials = Partial<Record<'airplay' | 'mrp' | 'companion', EncodedHap>> & {
  /** Imported old CLI HAP credentials whose original carrier was not recorded; never auto-selected. */
  unclassified?: EncodedHap;
  raop?: { clientId: string; seed: string };
  dmap?: { guid: string };
};
export interface EndpointHints { address?: string; port?: number; companionPort?: number; mrpPort?: number; dmapAddress?: string; dmapPort?: number; raopAddress?: string; raopPort?: number; }
export interface DeviceRecord { key: string; aliases: string[]; credentials?: ProtocolCredentials; hints?: EndpointHints; }
export interface StorageDocument { version: typeof STORAGE_VERSION; devices: DeviceRecord[]; }
export interface StorageAdapter { load(): Promise<StorageDocument | undefined>; save(document: StorageDocument): Promise<void>; }
export interface FileStorageOptions { mode?: number; }

function clone<T>(value: T): T { return structuredClone(value); }
function bad(message: string): never { throw new Error(`Invalid storage document: ${message}`); }
function hex(value: unknown, length: number, label: string): string {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) bad(`${label} must be a ${length}-byte hex value`);
  return value;
}
function hap(value: unknown, label: string): asserts value is EncodedHap {
  if (!value || typeof value !== 'object') bad(`${label} must be an object`);
  const c = value as Record<string, unknown>;
  if (typeof c.clientId !== 'string' || !c.clientId || typeof c.serverId !== 'string' || !c.serverId) bad(`${label} lacks identifiers`);
  hex(c.clientLTSK, 32, `${label}.clientLTSK`); hex(c.clientLTPK, 32, `${label}.clientLTPK`); hex(c.serverLTPK, 32, `${label}.serverLTPK`);
}
function validate(document: unknown): asserts document is StorageDocument {
  if (!document || typeof document !== 'object') bad('must be an object');
  const d = document as Record<string, unknown>;
  if (d.version !== STORAGE_VERSION) throw new Error(`Unsupported storage document version: ${String(d.version)}`);
  if (!Array.isArray(d.devices)) bad('devices must be an array');
  const keys = new Set<string>(); const aliases = new Set<string>();
  for (const record of d.devices) {
    if (!record || typeof record !== 'object') bad('device must be an object');
    const r = record as DeviceRecord;
    if (typeof r.key !== 'string' || !r.key || keys.has(r.key)) bad('device keys must be unique nonempty strings');
    keys.add(r.key);
    if (!Array.isArray(r.aliases) || r.aliases.some(a => typeof a !== 'string' || !a)) bad('aliases must be nonempty strings');
    for (const alias of r.aliases) { const id = alias.toLowerCase(); if (aliases.has(id)) bad(`alias ${alias} belongs to more than one record`); aliases.add(id); }
    for (const protocol of ['airplay', 'mrp', 'companion', 'unclassified'] as const) if (r.credentials?.[protocol]) hap(r.credentials[protocol], protocol);
    if (r.credentials?.raop) { if (typeof r.credentials.raop.clientId !== 'string' || !r.credentials.raop.clientId) bad('raop lacks clientId'); hex(r.credentials.raop.seed, 32, 'raop.seed'); }
    if (r.credentials?.dmap && (typeof r.credentials.dmap.guid !== 'string' || !r.credentials.dmap.guid)) bad('dmap lacks guid');
  }
}
function encodeHap(value: HAPCredentials): EncodedHap { return { clientId: value.clientId, clientLTSK: value.clientLTSK.toString('hex'), clientLTPK: value.clientLTPK.toString('hex'), serverLTPK: value.serverLTPK.toString('hex'), serverId: value.serverId }; }
function decodeHap(value: EncodedHap): HAPCredentials { hap(value, 'credential'); return { clientId: value.clientId, clientLTSK: Buffer.from(value.clientLTSK, 'hex'), clientLTPK: Buffer.from(value.clientLTPK, 'hex'), serverLTPK: Buffer.from(value.serverLTPK, 'hex'), serverId: value.serverId }; }

/** Common asynchronous store contract. Call load before lookup/update, then save explicitly. */
export class DeviceStorage {
  protected document: StorageDocument = { version: STORAGE_VERSION, devices: [] };
  private loaded = false; private changed = false;
  constructor(private readonly adapter: StorageAdapter) {}
  async load(): Promise<void> { const value = await this.adapter.load(); if (value) validate(value); this.document = value ? clone(value) : { version: STORAGE_VERSION, devices: [] }; this.loaded = true; this.changed = false; }
  private ready(): void { if (!this.loaded) throw new Error('Storage must be loaded before use'); }
  get dirty(): boolean { return this.changed; }
  records(): readonly DeviceRecord[] { this.ready(); return clone(this.document.devices); }
  get(keyOrAlias: string): DeviceRecord | undefined { this.ready(); const lower = keyOrAlias.toLowerCase(); return clone(this.document.devices.find(r => r.key === keyOrAlias || r.aliases.some(a => a.toLowerCase() === lower))); }
  /** Finds a record only when aliases select exactly one record. */
  resolve(alias: string): DeviceRecord | undefined { return this.get(alias); }
  upsert(record: DeviceRecord): void { this.ready(); validate({ version: STORAGE_VERSION, devices: [record] }); const index = this.document.devices.findIndex(r => r.key === record.key); const aliases = new Set(record.aliases.map(a => a.toLowerCase())); if (this.document.devices.some((r, i) => i !== index && r.aliases.some(a => aliases.has(a.toLowerCase())))) throw new Error('Storage alias collision requires explicit record selection'); if (index < 0) this.document.devices.push(clone(record)); else this.document.devices[index] = clone(record); this.changed = true; }
  remove(key: string): boolean { this.ready(); const index = this.document.devices.findIndex(r => r.key === key); if (index < 0) return false; this.document.devices.splice(index, 1); this.changed = true; return true; }
  setHap(key: string, protocol: 'airplay' | 'mrp' | 'companion', credentials: HAPCredentials, aliases = [key]): void { const record = this.get(key) ?? { key, aliases }; record.credentials = { ...record.credentials, [protocol]: encodeHap(credentials) }; this.upsert(record); }
  hap(key: string, protocol: 'airplay' | 'mrp' | 'companion'): HAPCredentials | undefined { const value = this.get(key)?.credentials?.[protocol]; return value ? decodeHap(value) : undefined; }
  /** Preserve old credentials without assigning them to AirPlay or standalone MRP. */
  setUnclassifiedHap(key: string, credentials: HAPCredentials, aliases = [key]): void { const record = this.get(key) ?? { key, aliases }; record.credentials = { ...record.credentials, unclassified: encodeHap(credentials) }; this.upsert(record); }
  async save(): Promise<void> { this.ready(); if (!this.changed) return; validate(this.document); await this.adapter.save(clone(this.document)); this.changed = false; }
}

/** In-memory adapter, useful for tests and applications that do not want persistence. */
export class MemoryStorage extends DeviceStorage {
  private value?: StorageDocument;
  constructor(initial?: StorageDocument) { let self: MemoryStorage; super({ load: async () => self.value && clone(self.value), save: async d => { self.value = clone(d); } }); self = this; this.value = initial && clone(initial); }
}
/** A custom adapter can store the versioned document in a keychain, database, or cloud service. */
export class CustomStorage extends DeviceStorage { constructor(adapter: StorageAdapter) { super(adapter); } }
/** JSON file adapter with atomic same-directory replacement. One FileStorage writer per path is supported. */
export class FileStorage extends DeviceStorage {
  constructor(readonly path: string, options: FileStorageOptions = {}) {
    const mode = options.mode ?? 0o600;
    super({
      load: async () => { try { return JSON.parse(await readFile(path, 'utf8')) as StorageDocument; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } },
      save: async document => {
        const directory = dirname(path); const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try { await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { mode, flag: 'wx' }); await chmod(temporary, mode); await rename(temporary, path); await chmod(path, mode); }
        catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      },
    });
  }
}
