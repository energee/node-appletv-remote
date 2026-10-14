/**
 * Bonjour/mDNS discovery of Apple TVs: browses `_airplay._tcp` for devices and
 * `_companion-link._tcp` for their Companion ports, then joins the two by address.
 */

import { Bonjour, type Service } from 'bonjour-service';

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
  /** AirPlay port. */
  port: number;
  deviceId: string;
  model: string;
  /** Companion-link port, when a matching `_companion-link._tcp` service was found. */
  companionPort?: number;
}

/** An Apple TV found by scan(). */
export class DiscoveredDevice {
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly deviceId: string;
  readonly model: string;
  companionPort?: number;

  constructor(info: DiscoveredDeviceInfo) {
    this.name = info.name;
    this.address = info.address;
    this.port = info.port;
    this.deviceId = info.deviceId;
    this.model = info.model;
    this.companionPort = info.companionPort;
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
}

/** Routable IPv4 addresses, in advertised order (link-local 169.254.x.x excluded). */
function usableAddresses(service: Service): string[] {
  return (service.addresses ?? []).filter((a) => a.includes('.') && !a.startsWith('169.254'));
}

/**
 * Browse the local network for `timeout` ms and return discovered Apple TVs
 * sorted by name. Devices are deduplicated by AirPlay device ID (or address);
 * services with no routable IPv4 address are skipped. Never rejects.
 */
export async function scan(options: ScanOptions = {}): Promise<DiscoveredDevice[]> {
  const timeout = options.timeout ?? 5000;
  const devices = new Map<string, DiscoveredDevice>();
  const companionPorts = new Map<string, number>();
  const airplayAddresses = new Map<string, string[]>();

  return new Promise((resolve) => {
    const instance = new Bonjour();

    const browser = instance.find({ type: 'airplay', protocol: 'tcp' }, (service: Service) => {
      const addresses = usableAddresses(service);
      const address = addresses[0];
      if (!address) return;

      const txt = service.txt as Record<string, string>;
      const parsed = parseAirPlayTxt(txt);
      const key = parsed.deviceId || address;

      if (!devices.has(key)) {
        devices.set(
          key,
          new DiscoveredDevice({
            name: service.name,
            address,
            port: service.port,
            deviceId: parsed.deviceId,
            model: parsed.model,
          }),
        );
        airplayAddresses.set(key, addresses);
      }
    });

    const companionBrowser = instance.find(
      { type: 'companion-link', protocol: 'tcp' },
      (service: Service) => {
        // A multihomed TV may list its addresses in a different order per service,
        // so index the port under every address rather than only the first.
        for (const address of usableAddresses(service)) {
          companionPorts.set(address, service.port);
        }
      },
    );

    setTimeout(() => {
      browser.stop();
      companionBrowser.stop();
      instance.destroy();

      let result = Array.from(devices.values());
      // Join once after both browsers stop, independent of advertisement order.
      for (const [key, device] of devices) {
        const match = airplayAddresses.get(key)!.find((a) => companionPorts.has(a));
        device.companionPort = match === undefined ? undefined : companionPorts.get(match);
      }
      if (options.filter) {
        result = result.filter(options.filter);
      }
      resolve(result.sort((a, b) => a.name.localeCompare(b.name)));
    }, timeout);
  });
}
