/**
 * Bonjour discovery of independent AirPlay, Companion, standalone MRP and legacy DMAP services.
 * Modern services join by compatible protocol identity, hostname, or address overlap.
 * DMAP requires a shared primary-protocol endpoint; mDNS associations are not authenticated.
 */

import { Bonjour, type Service } from 'bonjour-service';
import { isIP } from 'node:net';

/** Fields this library reads from an `_airplay._tcp` TXT record. */
export interface AirPlayTxtRecord {
  deviceId: string;
  /** Feature bitmask string as advertised; `0x0` when absent. */
  features: string;
  model: string;
  /** Pairing identifier (`pi` TXT key), if advertised. */
  pi?: string;
}

/** Extract AirPlayTxtRecord fields from raw TXT key/values, defaulting missing ones. */
export function parseAirPlayTxt(txt: Record<string, string>): AirPlayTxtRecord {
  return {
    deviceId: txt.deviceid ?? '',
    features: txt.features ?? '0x0',
    model: txt.model ?? 'Unknown',
    pi: txt.pi,
  };
}

/** Lowercase TXT keys and stringify values, as every Bonjour consumer here expects. */
export function normalizeTxt(txt: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(txt ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

/** Plain connection details for a device; accepted by DiscoveredDevice and AppleTV constructors. */
export interface DiscoveredDeviceInfo {
  name: string;
  address: string;
  /** AirPlay port; zero when AirPlay was not advertised. */
  port: number;
  deviceId: string;
  model: string;
  /** Companion-link port, when a matching `_companion-link._tcp` service was found. */
  companionPort?: number;
  /** Standalone MRP port, independent of the AirPlay tunnel. */
  mrpPort?: number;
  /** False for standalone advertisements on tvOS 15+ (Darwin build 19+). */
  mrpEnabled?: boolean;
  /** Advertised aliases, not authenticated identities; DMAP instances use `dmap:`. */
  identifiers?: string[];
  /** Service-specific endpoints; addresses can differ across address families. */
  companionAddress?: string;
  mrpAddress?: string;
  /** Legacy DMAP endpoint, independent of AirPlay. */
  dmapPort?: number;
  /** Shared primary-protocol address when joined; caller-supplied endpoints require explicit trust. */
  dmapAddress?: string;
  /** AirPlay `psi` TXT value: the ID to pass to AppleTV output routing (add/remove/setOutputDevices). */
  airplayPsi?: string;
}

/** An Apple TV found by scan(). */
export class DiscoveredDevice {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly deviceId: string;
  readonly model: string;
  companionPort?: number;
  /** Standalone MRP port, independent of the AirPlay tunnel. */
  mrpPort?: number;
  /** False for standalone advertisements on tvOS 15+ (Darwin build 19+). */
  mrpEnabled?: boolean;
  /** Advertised aliases, not authenticated identities; DMAP instances use `dmap:`. */
  identifiers?: string[];
  /** Service-specific endpoints; addresses can differ across address families. */
  companionAddress?: string;
  mrpAddress?: string;
  /** Legacy DMAP endpoint, independent of AirPlay. */
  dmapPort?: number;
  /** Shared primary-protocol address when joined; caller-supplied endpoints require explicit trust. */
  dmapAddress?: string;
  /** AirPlay `psi` TXT value: the ID to pass to AppleTV output routing (add/remove/setOutputDevices). */
  airplayPsi?: string;

  constructor(info: DiscoveredDeviceInfo) {
    this.name = info.name;
    this.address = info.address;
    this.port = info.port;
    this.deviceId = info.deviceId;
    this.model = info.model;
    this.companionPort = info.companionPort;
    this.mrpPort = info.mrpPort;
    this.mrpEnabled = info.mrpEnabled;
    this.identifiers = info.identifiers ?? [info.deviceId];
    this.companionAddress = info.companionAddress;
    this.mrpAddress = info.mrpAddress;
    this.dmapPort = info.dmapPort;
    this.dmapAddress = info.dmapAddress;
    this.airplayPsi = info.airplayPsi;
  }

  /** `name (address:port) [model]`. */
  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}

/** Options for scan(). */
export interface ScanOptions {
  /** How long to browse, in ms; default 5000. */
  timeout?: number;
  /** Keep only devices for which this returns true. */
  filter?: (device: DiscoveredDevice) => boolean;
  /**
   * Stop browsing early once any (filtered) device satisfies this; `timeout` still caps the wait.
   * Checked after every mDNS record, once the Companion port has been joined.
   */
  until?: (device: DiscoveredDevice) => boolean;
}

/** Usable unicast addresses, preferring IPv4 for compatibility; scoped IPv6 is preserved. */
function usableAddresses(service: Service): string[] {
  return (service.addresses ?? []).filter((address) => {
    const family = isIP(address);
    if (family === 4) return !/^(169\.254\.|127\.|0\.|22[4-9]\.|23\d\.)/.test(address);
    if (family !== 6) return false;
    const ip = address.split('%')[0].toLowerCase();
    return ip !== '::' && ip !== '::1' && !ip.startsWith('ff') &&
      (!/^fe[89ab]/.test(ip) || address.includes('%'));
  }).sort((a, b) => (isIP(a) === 4 ? 0 : 1) - (isIP(b) === 4 ? 0 : 1));
}

/** Browse unauthenticated services; ambiguous associations stay separate. Callback errors stop all browsers. */
export async function scan(options: ScanOptions = {}): Promise<DiscoveredDevice[]> {
  type RecordEntry = {
    type: string; service: Service; addresses: string[]; txt: Record<string, string>;
    ids: string[]; identity: { mac?: string; mrp?: string; dmap?: string };
  };
  const records: RecordEntry[] = [];
  return new Promise((resolve, reject) => {
    const instance = new Bonjour();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let untilQueued = false;
    const browsers: ReturnType<Bonjour['find']>[] = [];

    const collect = (): DiscoveredDevice[] => {
      const groups: RecordEntry[][] = [];
      const priority = ['airplay', 'mediaremotetv', 'companion-link', 'touch-able', 'appletv-v2'];
      // Establish primary devices first, independent of callback arrival order.
      const ordered = records.map(record => ({
        record, priority: priority.indexOf(record.type),
        key: JSON.stringify([record.ids, record.service.host, record.service.name, record.addresses, record.service.port]),
      })).sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key)).map(({ record }) => record);
      for (const record of ordered) {
        const matching = groups.filter((group) => {
          // A copied identity cannot join disjoint endpoints for the same protocol.
          if (group.some(other => other.type === record.type && other.service.host && record.service.host &&
            other.service.host.toLowerCase() !== record.service.host.toLowerCase() &&
            !record.addresses.some(address => other.addresses.includes(address)))) return false;
          // Host/address matches stay anchored; compatible modern identity aliases may span protocols.
          const anchors = group.filter(other => other.type === group[0].type);
          if (record.identity.dmap || group[0].identity.dmap) {
            return anchors.some(other => record.addresses.some(address => other.addresses.includes(address)));
          }
          const namespaces = ['mac', 'mrp'] as const;
          if (group.some(other => namespaces.some(key => record.identity[key] && other.identity[key] &&
            record.identity[key] !== other.identity[key]))) return false;
          return group.some(other => namespaces.some(key =>
            record.identity[key] && record.identity[key] === other.identity[key])) || anchors.some(other =>
            (record.service.host && record.service.host.toLowerCase() === other.service.host?.toLowerCase()) ||
            record.addresses.some(address => other.addresses.includes(address)));
        });
        // Never use a bridging advertisement to merge devices or pick one arbitrarily.
        if (matching.length === 1) matching[0].push(record);
        else groups.push([record]);
      }
      const devices = groups.map((group) => {
        const airplay = group.find((r) => r.type === 'airplay');
        const companion = group.find((r) => r.type === 'companion-link');
        const mrp = group.find((r) => r.type === 'mediaremotetv');
        const dmap = group.find(r => r.type === 'touch-able') ?? group.find(r => r.type === 'appletv-v2');
        const primary = airplay ?? mrp ?? dmap ?? companion!;
        const primaryAddresses = group.filter(record => record.type === primary.type &&
          record.service.host?.toLowerCase() === primary.service.host?.toLowerCase()).flatMap(record => record.addresses);
        const sharedAddress = (record: RecordEntry | undefined): string | undefined =>
          record?.addresses.find(address => primaryAddresses.includes(address)) ?? record?.addresses[0];
        // Never fall back to an unrelated DMAP address under a modern device identity.
        const dmapAddress = dmap?.addresses.find(address => primaryAddresses.includes(address));
        const identifiers = [...new Set([airplay, mrp, dmap, companion].flatMap((r) => r?.ids ?? []))];
        const build = Number(mrp?.txt.systembuildversion?.match(/^(\d+)[A-Z]/)?.[1]);
        return new DiscoveredDevice({
          name: primary.txt.ctln ?? primary.txt.name ?? primary.service.name ?? 'Unknown',
          address: primary.addresses[0], port: airplay?.service.port ?? 0,
          deviceId: identifiers[0] ?? primary.service.host ?? primary.service.fqdn ?? primary.service.name,
          identifiers,
          model: airplay?.txt.model ?? companion?.txt.rpmd ?? (dmap ? 'Legacy DMAP device' : 'Unknown'),
          dmapPort: dmapAddress ? dmap?.service.port : undefined, dmapAddress,
          companionPort: companion?.service.port, companionAddress: sharedAddress(companion),
          mrpPort: mrp?.service.port, mrpAddress: sharedAddress(mrp),
          mrpEnabled: mrp ? !(build >= 19) : undefined,
          airplayPsi: airplay?.txt.psi,
        });
      });
      return options.filter ? devices.filter(options.filter) : devices;
    };
    const cleanup = (): void => {
      done = true;
      clearTimeout(timer);
      for (const browser of browsers) browser.stop();
      instance.destroy();
    };
    const fail = (error: unknown): void => { if (!done) { cleanup(); reject(error); } };
    const finish = (): void => {
      if (done) return;
      try {
        const result = collect().sort((a, b) => a.name.localeCompare(b.name));
        cleanup(); resolve(result);
      } catch (error) { fail(error); }
    };
    for (const type of ['airplay', 'companion-link', 'mediaremotetv', 'touch-able', 'appletv-v2']) {
      browsers.push(instance.find({ type, protocol: 'tcp' }, (service: Service) => {
        if (done) return;
        const addresses = usableAddresses(service);
        if (!addresses.length || !service.port) return;
        const txt = normalizeTxt(service.txt);
        if (type === 'companion-link' && txt.rpmd && !txt.rpmd.startsWith('AppleTV')) return;
        const legacy = type === 'touch-able' || type === 'appletv-v2';
        const ids = (type === 'airplay' ? [txt.deviceid] : type === 'companion-link' ? [txt.rpmrtid] : type === 'mediaremotetv' ? [txt.uniqueidentifier, txt.macaddress] : [service.name ? `dmap:${service.name}` : undefined]).filter((id): id is string => !!id);
        // Only documented cross-protocol identifiers share a namespace. DMAP instance names do not.
        const identity = {
          mac: (type === 'airplay' ? txt.deviceid : type === 'mediaremotetv' ? txt.macaddress : undefined)?.toLowerCase(),
          mrp: (type === 'companion-link' ? txt.rpmrtid : type === 'mediaremotetv' ? txt.uniqueidentifier : undefined)?.toLowerCase(),
          dmap: legacy ? (service.name || service.fqdn || 'unknown').toLowerCase() : undefined,
        };
        records.push({ type, service, addresses, txt, ids, identity });
        // Regrouping is order-independent and O(n log n); evaluate once per burst, not per record.
        if (options.until && !untilQueued) {
          untilQueued = true;
          queueMicrotask(() => {
            untilQueued = false;
            if (done) return;
            try { if (collect().some(options.until!)) finish(); }
            catch (error) { fail(error); }
          });
        }
      }));
    }
    timer = setTimeout(finish, options.timeout ?? 5000);
  });
}
