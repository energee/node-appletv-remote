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
  /** Written only by unreleased pre-0.5.0 imports; still accepted on load, never auto-selected. */
  unclassified?: EncodedHap;
  raop?: { clientId: string; seed: string };
  dmap?: { guid: string };
};
export interface EndpointHints { name?: string; model?: string; address?: string; port?: number; companionAddress?: string; companionPort?: number; mrpAddress?: string; mrpPort?: number; mrpEnabled?: boolean; dmapAddress?: string; dmapPort?: number; raopAddress?: string; raopPort?: number; }
export interface ProtocolSettings { endpoint?: Partial<EndpointHints>; settleMs?: number; controllerName?: string; }
export type DeviceSettings = Partial<Record<Protocol, ProtocolSettings>>;
export interface DeviceRecord { key: string; aliases: string[]; credentials?: ProtocolCredentials; settings?: DeviceSettings; hints?: EndpointHints; }
/**
 * Version 1 preserves unrecognized fields when it rewrites a valid document so a
 * newer producer's metadata is not discarded. It rejects unknown version numbers.
 */
export interface StorageDocument { version: typeof STORAGE_VERSION; devices: DeviceRecord[]; }
export interface StorageAdapter { load(): Promise<StorageDocument | undefined>; save(document: StorageDocument): Promise<void>; }
export interface ConnectionResolution { protocol: Protocol; endpoint: EndpointHints; credentials?: HAPCredentials; dmapGuid?: string; raop?: { clientId: string; seed: Buffer }; settleMs?: number; controllerName?: string; }
export interface ResolveOptions extends ProtocolSettings { credentials?: HAPCredentials; dmapGuid?: string; raop?: { clientId: string; seed: Buffer }; }
export interface FileStorageOptions { mode?: number; }

function clone<T>(value: T): T { return structuredClone(value); }
function bad(message: string): never { throw new Error(`Invalid storage document: ${message}`); }
function hex(value: unknown, length: number, label: string): string {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) bad(`${label} must be a ${length}-byte hex value`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function hap(value: unknown, label: string): asserts value is EncodedHap {
  const c = object(value, label);
  if (typeof c.clientId !== 'string' || !c.clientId || typeof c.serverId !== 'string' || !c.serverId) bad(`${label} lacks identifiers`);
  hex(c.clientLTSK, 32, `${label}.clientLTSK`); hex(c.clientLTPK, 32, `${label}.clientLTPK`); hex(c.serverLTPK, 32, `${label}.serverLTPK`);
}
function validate(document: unknown): asserts document is StorageDocument {
  if (!document || typeof document !== 'object') bad('must be an object');
  const d = document as Record<string, unknown>;
  if (d.version !== STORAGE_VERSION) throw new Error(`Unsupported storage document version: ${String(d.version)}`);
  if (!Array.isArray(d.devices)) bad('devices must be an array');
  const owners = new Map<string, string>(); const keys = new Set<string>();
  for (const record of d.devices) {
    if (!record || typeof record !== 'object') bad('device must be an object');
    const r = record as DeviceRecord;
    if (typeof r.key !== 'string' || !r.key) bad('device keys must be nonempty strings');
    if (keys.has(r.key.toLowerCase())) bad('device keys must be unique case-insensitively');
    keys.add(r.key.toLowerCase());
    if (!Array.isArray(r.aliases) || r.aliases.some(a => typeof a !== 'string' || !a)) bad('aliases must be nonempty strings');
    for (const identifier of [r.key, ...r.aliases]) {
      const normalized = identifier.toLowerCase();
      const owner = owners.get(normalized);
      if (owner && owner.toLowerCase() !== r.key.toLowerCase()) bad(`identifier ${identifier} belongs to more than one record`);
      owners.set(normalized, r.key);
    }
    if (r.credentials !== undefined) {
      const credentials = object(r.credentials, 'credentials');
      for (const protocol of ['airplay', 'mrp', 'companion', 'unclassified'] as const) {
        if (credentials[protocol] !== undefined) hap(credentials[protocol], protocol);
      }
      if (credentials.raop !== undefined) {
        const raop = object(credentials.raop, 'raop');
        if (typeof raop.clientId !== 'string' || !/^[0-9A-F]{16}$/i.test(raop.clientId)) bad('raop clientId must be 16 hex characters');
        hex(raop.seed, 32, 'raop.seed');
      }
      if (credentials.dmap !== undefined) {
        const dmap = object(credentials.dmap, 'dmap');
        if (typeof dmap.guid !== 'string' || !/^0x[0-9A-F]{16}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dmap.guid)) bad('dmap guid must be a pairing GUID');
      }
    }
    endpoint(r.hints, 'hints');
    if (r.settings !== undefined) object(r.settings, 'settings');
    for (const [protocol, settings] of Object.entries(r.settings ?? {})) {
      if (!['airplay', 'mrp', 'companion', 'dmap', 'raop'].includes(protocol) || !settings || typeof settings !== 'object' || Array.isArray(settings)) bad('settings must be protocol objects');
      const value = settings as ProtocolSettings;
      endpoint(value.endpoint, `${protocol}.endpoint`);
      if (value.settleMs !== undefined && ((protocol !== 'airplay' && protocol !== 'mrp') || !Number.isFinite(value.settleMs) || value.settleMs < 0)) bad('settleMs is supported only by airplay/mrp');
      if (value.controllerName !== undefined && (protocol !== 'dmap' || typeof value.controllerName !== 'string' || !value.controllerName)) bad('controllerName is supported only by dmap');
    }
  }
}
function endpoint(value: unknown, label: string): void {
  if (value === undefined) return;
  const hint = object(value, label);
  for (const field of ['name', 'model', 'address', 'companionAddress', 'mrpAddress', 'dmapAddress', 'raopAddress']) if (hint[field] !== undefined && typeof hint[field] !== 'string') bad(`${label}.${field} must be a string`);
  for (const field of ['port', 'companionPort', 'mrpPort', 'dmapPort', 'raopPort']) if (hint[field] !== undefined && (!Number.isInteger(hint[field]) || (hint[field] as number) < (field === 'port' ? 0 : 1) || (hint[field] as number) > 65535)) bad(`${label}.${field} must be a port`);
  if (hint.mrpEnabled !== undefined && typeof hint.mrpEnabled !== 'boolean') bad(`${label}.mrpEnabled must be boolean`);
}
function encodeHap(value: HAPCredentials): EncodedHap { return { clientId: value.clientId, clientLTSK: value.clientLTSK.toString('hex'), clientLTPK: value.clientLTPK.toString('hex'), serverLTPK: value.serverLTPK.toString('hex'), serverId: value.serverId }; }
function decodeHap(value: EncodedHap): HAPCredentials { hap(value, 'credential'); return { clientId: value.clientId, clientLTSK: Buffer.from(value.clientLTSK, 'hex'), clientLTPK: Buffer.from(value.clientLTPK, 'hex'), serverLTPK: Buffer.from(value.serverLTPK, 'hex'), serverId: value.serverId }; }

/** Common asynchronous store contract. Call load before lookup/update, then save explicitly. */
export class DeviceStorage {
  protected document: StorageDocument = { version: STORAGE_VERSION, devices: [] };
  private loaded = false; private revision = 0; private savedRevision = 0;
  constructor(private readonly adapter: StorageAdapter) {}
  async load(): Promise<void> {
    const value = await this.adapter.load();
    if (value !== undefined) validate(value);
    this.document = value === undefined ? { version: STORAGE_VERSION, devices: [] } : clone(value);
    this.loaded = true;
    this.revision = 0;
    this.savedRevision = 0;
  }
  private ready(): void { if (!this.loaded) throw new Error('Storage must be loaded before use'); }
  get dirty(): boolean { return this.revision !== this.savedRevision; }
  records(): readonly DeviceRecord[] { this.ready(); return clone(this.document.devices); }
  private indexOf(key: string): number { const lower = key.toLowerCase(); return this.document.devices.findIndex(record => record.key.toLowerCase() === lower); }
  get(keyOrAlias: string): DeviceRecord | undefined { this.ready(); const lower = keyOrAlias.toLowerCase(); return clone(this.document.devices.find(record => record.key.toLowerCase() === lower || record.aliases.some(alias => alias.toLowerCase() === lower))); }
  /** Finds a record only when aliases select exactly one record. */
  resolve(alias: string): DeviceRecord | undefined { return this.get(alias); }
  upsert(record: DeviceRecord): void { this.ready(); const index = this.indexOf(record.key); const existing = index < 0 ? undefined : this.document.devices[index]!; const merged: DeviceRecord = existing ? { ...existing, ...record, credentials: record.credentials ? { ...existing.credentials, ...record.credentials } : existing.credentials, settings: record.settings ? { ...existing.settings, ...record.settings } : existing.settings, hints: record.hints ?? existing.hints } : record; validate({ version: STORAGE_VERSION, devices: [...this.document.devices.filter((_, i) => i !== index), merged] }); if (existing && JSON.stringify(existing) === JSON.stringify(merged)) return; if (index < 0) this.document.devices.push(clone(merged)); else this.document.devices[index] = clone(merged); this.revision++; }
  remove(key: string): boolean { this.ready(); const index = this.indexOf(key); if (index < 0) return false; this.document.devices.splice(index, 1); this.revision++; return true; }
  setHap(key: string, protocol: 'airplay' | 'mrp' | 'companion', credentials: HAPCredentials, aliases = [key]): void { const record = this.get(key) ?? { key, aliases }; record.credentials = { ...record.credentials, [protocol]: encodeHap(credentials) }; this.upsert(record); }
  hap(key: string, protocol: 'airplay' | 'mrp' | 'companion'): HAPCredentials | undefined { const value = this.get(key)?.credentials?.[protocol]; return value ? decodeHap(value) : undefined; }
  /** Explicitly remove one protocol credential; omitted fields never erase secrets. */
  removeCredential(key: string, protocol: keyof ProtocolCredentials): boolean {
    this.ready();
    const index = this.indexOf(key);
    const existing = index < 0 ? undefined : this.document.devices[index]!;
    if (!existing?.credentials?.[protocol]) return false;
    const credentials = { ...existing.credentials };
    delete credentials[protocol];
    const updated: DeviceRecord = { ...existing };
    if (Object.keys(credentials).length === 0) delete updated.credentials;
    else updated.credentials = credentials;
    validate({ version: STORAGE_VERSION, devices: [...this.document.devices.filter((_, i) => i !== index), updated] });
    this.document.devices[index] = clone(updated);
    this.revision++;
    return true;
  }
  /** Explicitly remove one protocol's settings while retaining all other settings. */
  removeSettings(key: string, protocol: Protocol): boolean {
    this.ready();
    const index = this.indexOf(key);
    const existing = index < 0 ? undefined : this.document.devices[index]!;
    if (!existing?.settings?.[protocol]) return false;
    const settings = { ...existing.settings };
    delete settings[protocol];
    const updated: DeviceRecord = { ...existing };
    if (Object.keys(settings).length === 0) delete updated.settings;
    else updated.settings = settings;
    validate({ version: STORAGE_VERSION, devices: [...this.document.devices.filter((_, i) => i !== index), updated] });
    this.document.devices[index] = clone(updated);
    this.revision++;
    return true;
  }
  /** Resolve explicit options over stored protocol settings over nonsecret discovery hints. */
  resolveConnection(key: string, protocol: Protocol, explicit: ResolveOptions = {}): ConnectionResolution {
    const record = this.get(key);
    if (!record) throw new Error(`No storage record matches "${key}"`);
    const stored = record.settings?.[protocol] ?? {};
    const endpoint = { ...record.hints, ...stored.endpoint, ...explicit.endpoint };
    const storedCredentials = protocol === 'airplay' || protocol === 'mrp' || protocol === 'companion' ? this.hap(record.key, protocol) : undefined;
    const credentials = explicit.credentials ?? storedCredentials;
    const dmapGuid = explicit.dmapGuid ?? (protocol === 'dmap' ? record.credentials?.dmap?.guid : undefined);
    const raop = explicit.raop ?? (protocol === 'raop' && record.credentials?.raop ? { clientId: record.credentials.raop.clientId, seed: Buffer.from(record.credentials.raop.seed, 'hex') } : undefined);
    return { protocol, endpoint, credentials, dmapGuid, raop, settleMs: explicit.settleMs ?? stored.settleMs, controllerName: explicit.controllerName ?? stored.controllerName };
  }
  async save(): Promise<void> { this.ready(); if (!this.dirty) return; const revision = this.revision; const snapshot = clone(this.document); validate(snapshot); await this.adapter.save(snapshot); if (this.revision === revision) this.savedRevision = revision; }
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
    if ((mode & 0o077) !== 0) throw new Error('FileStorage mode must not grant group or other permissions');
    super({
      load: async () => { try { return JSON.parse(await readFile(path, 'utf8')) as StorageDocument; } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } },
      save: async document => {
        const directory = dirname(path); const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try { await writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { mode, flag: 'wx' }); await chmod(temporary, mode); await rename(temporary, path); }
        catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
      },
    });
  }
}
