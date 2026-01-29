import Bonjour, { type Service } from 'bonjour-service';

export interface AirPlayTxtRecord {
  deviceId: string;
  features: string;
  model: string;
  pi?: string;
}

export function parseAirPlayTxt(txt: Record<string, string>): AirPlayTxtRecord {
  return {
    deviceId: txt.deviceid ?? '',
    features: txt.features ?? '0x0',
    model: txt.model ?? 'Unknown',
    pi: txt.pi,
  };
}

export interface DiscoveredDeviceInfo {
  name: string;
  address: string;
  port: number;
  deviceId: string;
  model: string;
  companionPort?: number;
}

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

  toString(): string {
    return `${this.name} (${this.address}:${this.port}) [${this.model}]`;
  }
}

export interface ScanOptions {
  timeout?: number;
  filter?: (device: DiscoveredDevice) => boolean;
}

export async function scan(options: ScanOptions = {}): Promise<DiscoveredDevice[]> {
  const timeout = options.timeout ?? 5000;
  const devices = new Map<string, DiscoveredDevice>();

  return new Promise((resolve) => {
    const bonjour = new Bonjour();

    const browser = bonjour.find({ type: 'airplay', protocol: 'tcp' }, (service: Service) => {
      const address = service.addresses?.find(
        (a) => a.includes('.') && !a.startsWith('169.254'),
      );
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
      }
    });

    const companionBrowser = bonjour.find(
      { type: 'companion-link', protocol: 'tcp' },
      (service: Service) => {
        const address = service.addresses?.find(
          (a) => a.includes('.') && !a.startsWith('169.254'),
        );
        if (!address) return;

        for (const device of devices.values()) {
          if (device.address === address) {
            device.companionPort = service.port;
          }
        }
      },
    );

    setTimeout(() => {
      browser.stop();
      companionBrowser.stop();
      bonjour.destroy();

      let result = Array.from(devices.values());
      if (options.filter) {
        result = result.filter(options.filter);
      }
      resolve(result.sort((a, b) => a.name.localeCompare(b.name)));
    }, timeout);
  });
}
