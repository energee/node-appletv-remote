/**
 * Bonjour discovery of independent AirPlay, Companion, standalone MRP and legacy DMAP services.
 * Joins services by stable identity, hostname, or overlapping usable addresses.
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
  /** Stable advertised IDs across services, for matching stored credentials. */
  identifiers?: string[];
  /** Service-specific endpoints; addresses can differ across address families. */
  companionAddress?: string;
  mrpAddress?: string;
  /** Legacy DMAP endpoint, independent of AirPlay. */
  dmapPort?: number;
  dmapAddress?: string;
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
  /** Stable advertised IDs across services, for matching stored credentials. */
  identifiers?: string[];
  /** Service-specific endpoints; addresses can differ across address families. */
  companionAddress?: string;
  mrpAddress?: string;
  /** Legacy DMAP endpoint, independent of AirPlay. */
  dmapPort?: number;
  dmapAddress?: string;

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

/** Browse supported services and join stable aliases. Callback errors reject after stopping all browsers. */
export async function scan(options: ScanOptions = {}): Promise<DiscoveredDevice[]> {
  type RecordEntry = { type: string; service: Service; addresses: string[]; txt: Record<string, string>; ids: string[] };
  const records: RecordEntry[] = [];
  return new Promise((resolve, reject) => {
    const instance = new Bonjour();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const browsers: ReturnType<Bonjour['find']>[] = [];

    const collect = (): DiscoveredDevice[] => {
      const groups: RecordEntry[][] = [];
      for (const record of records) {
        const matching = groups.filter((group) => group.some((other) =>
          record.ids.some((id) => other.ids.some((candidate) => candidate.toLowerCase() === id.toLowerCase())) ||
          (record.service.host && record.service.host.toLowerCase() === other.service.host?.toLowerCase()) ||
          record.addresses.some((address) => other.addresses.includes(address))));
        const merged = [record, ...matching.flat()];
        for (const group of matching) groups.splice(groups.indexOf(group), 1);
        groups.push(merged);
      }
      const devices = groups.map((group) => {
        const airplay = group.find((r) => r.type === 'airplay');
        const companion = group.find((r) => r.type === 'companion-link');
        const mrp = group.find((r) => r.type === 'mediaremotetv');
        const dmap = group.find(r => r.type === 'touch-able') ?? group.find(r => r.type === 'appletv-v2');
        const primary = airplay ?? mrp ?? dmap ?? companion!;
        const identifiers = [...new Set([airplay, mrp, dmap, companion].flatMap((r) => r?.ids ?? []))];
        const build = Number(mrp?.txt.systembuildversion?.match(/^(\d+)[A-Z]/)?.[1]);
        return new DiscoveredDevice({
          name: primary.txt.ctln ?? primary.txt.name ?? primary.service.name ?? 'Unknown',
          address: primary.addresses[0], port: airplay?.service.port ?? 0,
          deviceId: identifiers[0] ?? primary.service.host ?? primary.service.fqdn ?? primary.service.name,
          identifiers,
          model: airplay?.txt.model ?? companion?.txt.rpmd ?? (dmap ? 'Legacy DMAP device' : 'Unknown'),
          dmapPort: dmap?.service.port, dmapAddress: dmap?.addresses[0],
          companionPort: companion?.service.port, companionAddress: companion?.addresses[0],
          mrpPort: mrp?.service.port, mrpAddress: mrp?.addresses[0],
          mrpEnabled: mrp ? !(build >= 19) : undefined,
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
        const txt = Object.fromEntries(Object.entries(service.txt ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
        if (type === 'companion-link' && txt.rpmd && !txt.rpmd.startsWith('AppleTV')) return;
        const ids = (type === 'airplay' ? [txt.deviceid] : type === 'companion-link' ? [txt.rpmrtid] : type === 'mediaremotetv' ? [txt.uniqueidentifier, txt.macaddress] : [service.name]).filter((id): id is string => !!id);
        records.push({ type, service, addresses, txt, ids });
        try { if (options.until && collect().some(options.until)) finish(); }
        catch (error) { fail(error); }
      }));
    }
    timer = setTimeout(finish, options.timeout ?? 5000);
  });
}
