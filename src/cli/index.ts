#!/usr/bin/env node
/**
 * `atv` command-line tool: scan, pair, control playback/text, touch, output routing and Companion,
 * inspect now-playing, keyboard, and Companion events, control legacy DMAP Apple TVs, and stream raw
 * PCM to legacy RAOP receivers (experimental). Pairings and endpoint hints use the
 * public versioned FileStorage API; legacy CLI JSON is imported once without deletion.
 */
import { scan, normalizeTxt, type DiscoveredDeviceInfo } from '../discovery.js';
import { parseTargets } from '../targeted-mdns.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AppleTV, Key, ShuffleState, RepeatState, contentItems, INPUT_ACTIONS } from '../appletv.js';
import { PlaybackState } from '../now-playing-info.js';
import { MessageType, HID_KEY_MAP } from '../mrp/messages.js';
import { Credentials } from '../credentials.js';
import type { HAPCredentials } from '../auth/types.js';
import { FileStorage, type DeviceRecord, type EndpointHints } from '../storage.js';
import { DeviceSession, KEY_OPERATIONS, supportsSessionOperation } from '../session.js';
import type { ControlProtocol, SessionOperation, SessionCredentials } from '../session.js';
import { DmapPairing } from '../dmap/pairing.js';
import { RaopStream } from '../raop/stream.js';
import { extractRaopMetadata } from '../raop/metadata.js';
import { openRaopInput, type RaopInput } from './raop-input.js';
import { Bonjour, type Service } from 'bonjour-service';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createInterface } from 'node:readline';
import type { Message } from '../message.js';
import type { KeyboardInfo, TextInputEvent, CompanionEvent, App, UserAccount, InputAction } from '../appletv.js';
import type { NowPlayingInfo } from '../now-playing-info.js';

/** Versioned CLI state. Plaintext storage is protected by restrictive file permissions, not a keychain. */
const STORAGE_FILE = join(process.env.HOME ?? '.', '.atv-storage.json');
const CREDS_FILE = join(process.env.HOME ?? '.', '.atv-credentials.json');
const DMAP_FILE = join(process.env.HOME ?? '.', '.atv-dmap.json');
const DEVICES_FILE = join(process.env.HOME ?? '.', '.atv-devices.json');
const commandDeviceIds = new WeakMap<DeviceSession, string>();
const commandErrorDeviceIds = new WeakMap<object, string>();
let cliStore: FileStorage | undefined;

/** Load the shared store and perform the one-time, non-destructive legacy import. */
async function storage(): Promise<FileStorage> {
  if (cliStore) return cliStore;
  const store = new FileStorage(STORAGE_FILE);
  const hadDocument = existsSync(STORAGE_FILE);
  await store.load();
  if (!hadDocument) {
    const modern = existsSync(CREDS_FILE) ? JSON.parse(readFileSync(CREDS_FILE, 'utf8')) as Record<string, string> : {};
    const dmap = existsSync(DMAP_FILE) ? JSON.parse(readFileSync(DMAP_FILE, 'utf8')) as Record<string, string> : {};
    const cached = existsSync(DEVICES_FILE) ? JSON.parse(readFileSync(DEVICES_FILE, 'utf8')) as Record<string, EndpointHints> : {};
    for (const [key, serialized] of Object.entries(modern)) {
      const credentials = Credentials.deserialize(serialized);
      const companion = credentials.companionCredentials;
      if (companion && credentials.clientId === companion.clientId && credentials.clientLTSK.equals(companion.clientLTSK) && credentials.clientLTPK.equals(companion.clientLTPK) && credentials.serverLTPK.equals(companion.serverLTPK) && credentials.serverId === companion.serverId) {
        store.setHap(key, 'companion', companion, [key]);
      } else {
        // Every released `atv pair` (0.2.0–0.4.0) used AirPlay pair-setup; only unreleased builds
        // paired over standalone MRP, and only for devices cached without an AirPlay port.
        const hints = cached[key];
        const carrier = hints && !hints.port && hints.mrpPort ? 'mrp' : 'airplay';
        store.setHap(key, carrier, credentials, [key]);
        if (companion) store.setHap(key, 'companion', companion, [key]);
      }
    }
    for (const [key, guid] of Object.entries(dmap)) {
      if (typeof guid !== 'string' || !guid) throw new Error('Legacy DMAP credentials contain an invalid GUID');
      const record: DeviceRecord = store.get(key) ?? { key, aliases: [key] };
      record.credentials = { ...record.credentials, dmap: { guid } };
      store.upsert(record);
    }
    for (const [key, hints] of Object.entries(cached)) {
      if (!hints || typeof hints !== 'object') throw new Error('Legacy device cache contains an invalid endpoint');
      const record: DeviceRecord = store.get(key) ?? { key, aliases: [key] };
      record.hints = hints;
      store.upsert(record);
    }
    await store.save();
  }
  cliStore = store;
  return store;
}

/** Non-negative milliseconds from an environment variable, or the given fallback. */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
}
const settleMs = (): number => envMs('ATV_SETTLE_MS', 500);
const postSendMs = (): number => envMs('ATV_POST_SEND_MS', 1000);

/** Ask one question on stdin and resolve with the raw answer. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Promise.withResolvers is unavailable in the package's ES2022 target.
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer ?? '');
    });
  });
}

/** Number devices then return the user's selected member. */
async function selectDevice<T>(devices: T[], none: string, label: (device: T) => string): Promise<T | undefined> {
  if (devices.length === 0) {
    console.log(none);
    return undefined;
  }
  devices.forEach((device, index) => console.log(`  ${index + 1}. ${label(device)}`));
  const selected = devices[parseInt(await prompt('Select device number: '), 10) - 1];
  if (!selected) console.log('Invalid selection.');
  return selected;
}
/** Preserve each advertised identity once; scan includes deviceId in identifiers. */
function deviceAliases(device: DiscoveredDeviceInfo): string[] {
  return [...new Map([device.deviceId, ...(device.identifiers ?? [])].map(alias => [alias.toLowerCase(), alias])).values()];
}

/** `atv scan`: list Apple TVs and AirPlay receivers found via mDNS within 5 s, with each `psi` output ID. */
async function cmdScan(hosts: string[]) {
  console.log('Scanning for Apple TVs...');
  const devices = await scan({ timeout: 5000, hosts });
  if (devices.length === 0) {
    console.log('No Apple TVs found.');
    return;
  }
  devices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name} (${d.address}:${d.port}) [${d.model}]${d.airplayPsi ? ` psi=${d.airplayPsi}` : ''}`);
  });
}

/** Shared human/JSON targeted scan validation, before discovery opens sockets. */
function scanHosts(args: string[]): string[] {
  const hosts: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== '--host' || args[index + 1] === undefined) throw new Error('Usage: atv scan [--host <ip>]...');
    hosts.push(args[index + 1]);
  }
  parseTargets(hosts);
  return hosts;
}

/** `atv pair`: persist credentials under the carrier actually selected by discovery. */
async function cmdPair() {
  console.log('Scanning for Apple TVs...');
  const device = await selectDevice(await scan({ timeout: 5000 }), 'No Apple TVs found.', String);
  if (!device) return;
  const atv = new AppleTV(device);
  console.log(`Pairing with ${atv.name}...`);
  const hapCreds = await (await atv.startPairing()).finish(await prompt('Enter PIN shown on Apple TV: '));
  const store = await storage();
  store.setHap(device.deviceId, device.port ? 'airplay' : 'mrp', hapCreds, deviceAliases(device));
  await store.save();
  console.log(`Paired! Credentials saved to ${STORAGE_FILE}`);
}

/**
 * Pull an optional case-insensitive action word out of `args[index]`, which precedes an optional
 * device selector. When both are present (`args.length === index + 2`) the word must be an action.
 */
function splitAction(args: string[], index: number): { action?: InputAction; rest: string[] } {
  const action = INPUT_ACTIONS.find((a) => a.toLowerCase() === args[index]?.toLowerCase());
  if (action) return { action, rest: args.filter((_, i) => i !== index) };
  if (args.length === index + 2) throw new Error(`Invalid action: ${args[index]} (expected ${INPUT_ACTIONS.join(', ')})`);
  return { rest: args };
}

/** Every Key value; these strings are the accepted CLI command names. */
const COMMAND_NAMES = Object.values(Key);
/** Fast membership check for COMMAND_NAMES. */
const COMMAND_SET = new Set<string>(COMMAND_NAMES);

/** Select one credential record; ambiguous selectors never choose an arbitrary paired identity. */
async function loadRecord(deviceId?: string, protocol?: ControlProtocol): Promise<DeviceRecord> {
  if (deviceId !== undefined && !deviceId.trim()) throw new Error('Device selector must be nonblank');
  const records = (await storage()).records().filter(record => protocol ? !!record.credentials?.[protocol] :
    !!(record.credentials?.airplay || record.credentials?.mrp || record.credentials?.companion || record.credentials?.dmap));
  if (!records.length) throw new Error('No usable typed credentials found. Pair this device with the required protocol first.');
  if (deviceId === undefined) return records[records.length - 1];
  const selector = deviceId.toLowerCase();
  // A stored device name ("Living Room") selects only when it matches whole; a partial name is not an identity.
  const exact = records.filter(record => record.key.toLowerCase() === selector || record.hints?.name?.toLowerCase() === selector ||
    record.aliases.some(alias => alias.toLowerCase() === selector));
  const matches = exact.length ? exact : records.filter(record => record.key.toLowerCase().includes(selector) || record.aliases.some(alias => alias.toLowerCase().includes(selector)));
  if (matches.length > 1) throw new Error('Device selector is ambiguous; use an explicit record key');
  if (!matches.length) throw new Error(`No paired device matches "${deviceId}"`);
  return matches[0];
}

/** Match known record aliases exactly; a friendly-name substring is not a paired identity. */
async function findDevice(record: DeviceRecord, accepts: (device: DiscoveredDeviceInfo) => boolean, signal?: AbortSignal): Promise<DiscoveredDeviceInfo> {
  console.error('Finding device...');
  const aliases = new Set([record.key, ...record.aliases].map(alias => alias.toLowerCase()));
  const matches = (device: DiscoveredDeviceInfo) => aliases.has(device.deviceId.toLowerCase()) ||
    !!device.identifiers?.some(alias => aliases.has(alias.toLowerCase()));
  // The public session policy decides endpoint eligibility before any authentication or command.
  signal?.throwIfAborted();
  const devices = await scan({ timeout: 5000, signal, until: (device) => matches(device) && accepts(device) });
  const matchesFound = devices.filter(device => matches(device) && accepts(device));
  if (matchesFound.length > 1) throw new Error('Discovery identity is ambiguous; select a nonconflicting device record');
  const device = matchesFound[0];
  if (!device) {
    throw new Error(`Device not found on network (looking for "${record.key}"). Found: ${devices.map((d) => `${d.name} [${d.deviceId}]`).join(', ')}`);
  }
  return device;
}

/** Try nonsecret endpoint hints before discovery; retries stop before any operation is dispatched. */
async function connectCached(record: DeviceRecord, accepts: (device: DiscoveredDeviceInfo) => boolean, connect: (device: DiscoveredDeviceInfo) => Promise<DeviceSession>, signal?: AbortSignal, retry = true): Promise<DeviceSession> {
  const saved = record.hints;
  const endpoint = Object.values(record.settings ?? {}).map(settings => settings.endpoint)
    .find(value => value?.address || value?.companionAddress || value?.mrpAddress || value?.dmapAddress);
  const address = saved?.address ?? endpoint?.address ?? endpoint?.companionAddress ?? endpoint?.mrpAddress ?? endpoint?.dmapAddress;
  if (address) {
    const cached: DiscoveredDeviceInfo = { ...saved, name: saved?.name ?? record.key,
      deviceId: record.aliases[0] ?? record.key, identifiers: record.aliases,
      address, port: saved?.port ?? 0, model: saved?.model ?? '' };
    if (accepts(cached)) {
      if (!retry) return connect(cached);
      try { return await connect(cached); } catch { signal?.throwIfAborted(); }
    }
  }
  const device = await findDevice(record, accepts, signal);
  const result = await connect(device);
  try {
    const store = await storage();
    const hints: EndpointHints = { name: device.name, model: device.model, address: device.address, port: device.port,
      companionAddress: device.companionAddress, companionPort: device.companionPort,
      mrpAddress: device.mrpAddress, mrpPort: device.mrpPort, mrpEnabled: device.mrpEnabled,
      dmapAddress: device.dmapAddress, dmapPort: device.dmapPort, raopAddress: device.raopAddress, raopPort: device.raopPort };
    if (JSON.stringify(record.hints) !== JSON.stringify(hints)) { record.hints = hints; store.upsert(record); await store.save(); }
    return result;
  } catch (error) {
    await result.close();
    throw error;
  }
}

/** Use the same typed configuration and per-operation routing policy as public library consumers. */
async function connectSession(deviceId?: string, operations?: readonly SessionOperation[], protocol?: ControlProtocol, context?: JsonOperationContext, retry = true): Promise<DeviceSession> {
  const record = await loadRecord(deviceId, protocol);
  context?.select(record.key);
  context?.signal.throwIfAborted();
  const store = await storage();
  const credentials: SessionCredentials = {
    airplay: store.hap(record.key, 'airplay'), mrp: store.hap(record.key, 'mrp'),
    companion: store.hap(record.key, 'companion'), dmap: record.credentials?.dmap?.guid,
  };
  const carriers: ControlProtocol[] = protocol ? [protocol] : ['airplay', 'mrp', 'companion', 'dmap'];
  for (const operation of operations ?? []) {
    if (!carriers.some(carrier => credentials[carrier] !== undefined && supportsSessionOperation(carrier, operation))) {
      throw new Error(`No configured implementation for ${operation}`);
    }
  }
  const options = { credentials, operations,
    settleMs: process.env.ATV_SETTLE_MS === undefined ? undefined : settleMs(),
    protocolOptions: {
      airplay: { settleMs: record.settings?.airplay?.settleMs ?? 500 },
      mrp: { settleMs: record.settings?.mrp?.settleMs ?? 500 },
    },
    ...(protocol ? { transports: { [protocol]: {} } } : {}) };
  const configuredDevice = (device: DiscoveredDeviceInfo): DiscoveredDeviceInfo => {
    const airplay = record.settings?.airplay?.endpoint;
    const mrp = record.settings?.mrp?.endpoint;
    const companion = record.settings?.companion?.endpoint;
    const dmap = record.settings?.dmap?.endpoint;
    return { ...device,
      address: airplay?.address ?? device.address, port: airplay?.port ?? device.port,
      mrpAddress: mrp?.mrpAddress ?? mrp?.address ?? device.mrpAddress ?? device.address,
      mrpPort: mrp?.mrpPort ?? mrp?.port ?? device.mrpPort,
      companionAddress: companion?.companionAddress ?? companion?.address ?? device.companionAddress ?? device.address,
      companionPort: companion?.companionPort ?? companion?.port ?? device.companionPort,
      dmapAddress: dmap?.dmapAddress ?? dmap?.address ?? device.dmapAddress ?? device.address,
      dmapPort: dmap?.dmapPort ?? dmap?.port ?? device.dmapPort };
  };
  const accepts = (device: DiscoveredDeviceInfo) => {
    try { new DeviceSession(configuredDevice(device), options); return true; } catch { return false; }
  };
  return connectCached(record, accepts, async device => {
    console.error(`Connecting to ${device.name}...`);
    const session = new DeviceSession(configuredDevice(device), options);
    commandDeviceIds.set(session, record.key);
    context?.register(session);
    context?.signal.throwIfAborted();
    session.on('transportError', ({ protocol: source, error }: { protocol: ControlProtocol; error: Error }) => console.error(`${source} error: ${error.message}`));
    await session.connect();
    return session;
  }, context?.signal, retry);
}

/** Companion-only buttons exposed by `command`; no MRP connection is needed. */
const COMPANION_BUTTONS = {
  channel_up: 'channelUp', channel_down: 'channelDown', screensaver: 'screensaver',
  guide: 'guide', page_up: 'pageUp', page_down: 'pageDown',
} as const;


/**
 * Send a validated key or Companion button, optionally with an action mode, then close even if
 * sending fails. Only HID keys and Companion buttons accept an action; media keys, wake/suspend,
 * skips and `home_hold` are rejected before connecting.
 */
async function cmdCommand(command: string, action?: InputAction, deviceId?: string, json = false, context?: JsonOperationContext): Promise<JsonCommandResult | void> {
  const button = Object.hasOwn(COMPANION_BUTTONS, command)
    ? COMPANION_BUTTONS[command as keyof typeof COMPANION_BUTTONS] : undefined;
  const selectedOperation = button ?? KEY_OPERATIONS[command as Key];
  if (!button && !COMMAND_SET.has(command)) throw new Error(`Unknown command: ${command}. Run "atv --help".`);
  if (action && !button && !HID_KEY_MAP[command]) throw new Error(`Action modes are not supported for ${command}`);
  const atv = await connectSession(deviceId, [selectedOperation], undefined, context);
  try {
    context?.signal.throwIfAborted();
    if (button) await atv.execute(button, action);
    else await atv.sendKeyCommand(command as Key, action);
    if (!json) console.log(`Sent: ${command}`);
    await delay(postSendMs(), undefined, { signal: context?.signal });
    return json ? { deviceId: commandDeviceIds.get(atv) ?? atv.device.deviceId, data: {
      acknowledged: button !== undefined || [Key.Play, Key.Pause, Key.Next, Key.Previous, Key.SkipForward, Key.SkipBackward].includes(command as Key),
      command, action: action ?? 'singleTap',
    } } : undefined;
  } catch (error) { commandFailure(error, atv); } finally {
    await atv.close();
  }
}

/** `atv remote [device]`: interactive prompt that sends each typed key name. */
async function cmdRemote(deviceId?: string) {
  const atv = await connectSession(deviceId);

  console.log(`Connected. Type commands to send (${COMMAND_NAMES.join(', ')})`);
  console.log('Type "quit" or "exit" to disconnect.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('atv> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim().toLowerCase();
    if (!input) { rl.prompt(); return; }
    if (input === 'quit' || input === 'exit') {
      await atv.close();
      rl.close();
      return;
    }
    if (input === 'help') {
      console.log(`Commands: ${COMMAND_NAMES.join(', ')}`);
      rl.prompt();
      return;
    }
    if (!COMMAND_SET.has(input)) {
      console.log(`Unknown: ${input}. Type "help" for commands.`);
    } else {
      try {
        await atv.sendKeyCommand(input as Key);
      } catch (e) {
        console.log(`Error: ${e}`);
      }
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await atv.close();
    process.exit(0);
  });
}

/** `atv state [device]`: print title, artist, album, play state, progress, and app for the current item. */
async function cmdState(deviceId?: string, json = false, context?: JsonOperationContext): Promise<JsonCommandResult | void> {
  const atv = await connectSession(deviceId, ['getNowPlaying'], undefined, context);
  try {
    context?.signal.throwIfAborted();
    console.error('Requesting state...');
    const info = await atv.execute('getNowPlaying');
    if (json) return { data: playbackData(info), deviceId: commandDeviceIds.get(atv) ?? atv.device.deviceId };
    const stopped = info.playbackState === PlaybackState.Stopped;
    const idle = !info.hasPlayback && (stopped || info.playbackState === PlaybackState.Unknown);
    console.log(idle ? `Nothing playing. [${stopped ? 'Stopped' : 'Absent'}]` : info.toString());
  } catch (error) { commandFailure(error, atv); } finally {
    await atv.close();
  }
}

/** `atv queue [device]`: print up to 20 items from the playback queue. */
async function cmdQueue(deviceId?: string, json = false, context?: JsonOperationContext): Promise<JsonCommandResult | void> {
  const atv = await connectSession(deviceId, ['requestPlaybackQueue'], undefined, context);
  try {
    context?.signal.throwIfAborted();
    console.error('Requesting playback queue...');
    const response = await atv.execute('requestPlaybackQueue', {
      location: 0,
      length: 20,
      includeMetadata: true,
    });
    const items = contentItems(response);
    if (json) return { deviceId: commandDeviceIds.get(atv) ?? atv.device.deviceId, data: { items: items.map((item) => {
      const metadata = item.metadata as Record<string, unknown> | undefined;
      return {
        id: typeof item.identifier === 'string' ? item.identifier : null,
        title: typeof metadata?.title === 'string' ? metadata.title : null,
        artist: typeof metadata?.trackArtistName === 'string' ? metadata.trackArtistName : typeof metadata?.albumArtistName === 'string' ? metadata.albumArtistName : null,
        album: typeof metadata?.albumName === 'string' ? metadata.albumName : null,
      };
    }) } };
    if (items.length > 0) {
      items.forEach((item, i) => {
        const metadata = item.metadata as Record<string, unknown> | undefined;
        const title = metadata?.title ?? item.identifier ?? '(unknown)';
        console.log(`  ${i + 1}. ${title}`);
      });
    } else console.log('No items in playback queue.');
  } catch (error) { commandFailure(error, atv); } finally {
    await atv.close();
  }
}

/** `atv artwork [device] [file]`: save 600x600 now-playing artwork (default artwork.jpg). */
async function cmdArtwork(deviceId?: string, outputFile?: string, json = false, context?: JsonOperationContext): Promise<JsonCommandResult | void> {
  const atv = await connectSession(deviceId, ['requestArtwork'], undefined, context);
  try {
    context?.signal.throwIfAborted();
    console.error('Requesting artwork...');
    const artwork = await atv.execute('requestArtwork', 600, 600);
    if (artwork) {
      const filename = outputFile ?? 'artwork.jpg';
      writeFileSync(filename, artwork);
      if (json) return { deviceId: commandDeviceIds.get(atv) ?? atv.device.deviceId, data: { path: filename, bytes: artwork.length, available: true } };
      console.log(`Artwork saved to ${filename} (${artwork.length} bytes)`);
    } else if (json) return { deviceId: commandDeviceIds.get(atv) ?? atv.device.deviceId, data: { available: false } };
    else console.log('No artwork available.');
  } catch (error) { commandFailure(error, atv); } finally {
    await atv.close();
  }
}

/** `atv messages [device]`: print every incoming MRP message until Ctrl+C. */
async function cmdMessages(deviceId?: string) {
  const atv = await connectSession(deviceId, ['getState']);
  console.log('Listening for messages (Ctrl+C to stop)...\n');

  atv.on('message', (msg: Message) => {
    console.log(msg.toString());
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv companion-pair`: preserve existing AirPlay pairing while adding proven Companion credentials. */
async function cmdCompanionPair() {
  console.log('Scanning for Apple TVs...');
  const device = await selectDevice((await scan({ timeout: 5000 })).filter((d) => d.companionPort),
    'No Apple TVs with companion-link found.', (d) => `${d} [companion:${d.companionPort}]`);
  if (!device) return;
  const atv = new AppleTV(device);
  console.log(`Companion pairing with ${atv.name} on port ${device.companionPort}...`);
  const companionCreds = await (await atv.startCompanionPairing()).finish(await prompt('Enter PIN shown on Apple TV: '));
  const store = await storage();
  store.setHap(device.deviceId, 'companion', companionCreds, deviceAliases(device));
  await store.save();
  console.log(`Companion paired! Credentials saved to ${STORAGE_FILE}`);
}

/** `atv companion-test [device]`: connect over Companion with stored credentials and print events until Ctrl+C. */
async function cmdCompanionTest(deviceId?: string) {
  const atv = await connectSession(deviceId, ['sendCompanionRequest'], 'companion');
  console.log('Companion connected! Listening for events (Ctrl+C to stop)...\n');

  atv.on('companionEvent', (event: CompanionEvent) => {
    console.log(`Event: ${event.identifier}`);
    const readable = Object.fromEntries(
      [...event.data].map(([k, v]) => [String(k), v]),
    );
    console.log(`  data: ${JSON.stringify(readable)}`);
  });

  atv.on('transportError', ({ error }: { error: Error }) => {
    console.error(`Companion error: ${error.message}`);
  });

  atv.on('connection', ({ state }: { state: string }) => {
    if (state === 'lost') console.log('Companion connection closed.');
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv keyboard [device]`: print keyboard focus and text-input events (plus their raw messages) until Ctrl+C. */
async function cmdKeyboard(deviceId?: string) {
  const atv = await connectSession(deviceId, ['getState']);
  console.log('Listening for keyboard/textInput events (Ctrl+C to stop)...\n');

  atv.on('keyboard', (info: KeyboardInfo) => {
    const parts = [`Keyboard: focused=${info.focused}`];
    if (info.title) parts.push(`title="${info.title}"`);
    if (info.prompt) parts.push(`prompt="${info.prompt}"`);
    console.log(parts.join(' '));
  });

  atv.on('textInput', (event: TextInputEvent) => {
    const parts = ['TextInput:'];
    if (event.text !== undefined) parts.push(`text="${event.text}"`);
    if (event.actionType !== undefined) parts.push(`action=${event.actionType}`);
    console.log(parts.join(' '));
  });

  atv.on('message', (msg: Message) => {
    // Also log raw keyboard/text messages for debugging
    const type = msg.type;
    if (type === MessageType.Keyboard || type === MessageType.TextInput) {
      console.log(`  raw: ${JSON.stringify(msg.payload)}`);
    }
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv output` verbs mapped to AppleTV routing methods (`list` is handled separately). */
const OUTPUT_METHODS = { add: 'addOutputDevices', remove: 'removeOutputDevices', set: 'setOutputDevices' } as const;

/** DMAP CLI command names mapped to DmapClient methods (`state` is handled separately). */
const DMAP_COMMANDS = {
  up: 'up', down: 'down', left: 'left', right: 'right', select: 'select', menu: 'menu', top_menu: 'topMenu',
  play: 'play', pause: 'pause', stop: 'stop', play_pause: 'playPause', next: 'next', previous: 'previous',
  volume_up: 'volumeUp', volume_down: 'volumeDown',
} as const;

/**
 * `atv dmap-pair <local-ipv4>`: advertise this computer as a Remote on the given local IPv4 interface,
 * show a random PIN to enter on the selected legacy Apple TV, and store the resulting pairing GUID
 * under the selected device's ID. Fails on lockout or expiry; Ctrl+C cancels and closes the server.
 */
async function cmdDmapPair(localAddress: string) {
  console.log('Scanning for legacy (DMAP) Apple TVs...');
  const device = await selectDevice((await scan({ timeout: 5000 })).filter((d) => d.dmapPort),
    'No DMAP devices found.', (d) => `${d.name} (${d.dmapAddress ?? d.address}:${d.dmapPort}) [${d.deviceId}]`);
  if (!device) return;

  const store = await storage();
  const controllerName = store.get(device.deviceId)?.settings?.dmap?.controllerName ?? 'atv CLI';
  const pin = String(randomInt(10000)).padStart(4, '0');
  const pairing = new DmapPairing({ name: controllerName, address: localAddress, pin });
  // Ctrl+C must still close the callback server and unpublish the _touch-remote advertisement.
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('DMAP pairing cancelled'));
  process.once('SIGINT', cancel);
  let guid: string;
  try {
    await pairing.start();
    console.log(`On ${device.name}, open Settings > General > Remotes, choose "${controllerName}" and enter PIN ${pin}.`);
    // DmapPairing has no completion event; poll until it pairs, locks out after five wrong PINs, or expires.
    for (;;) {
      try { guid = pairing.finish(); break; } catch (error) {
        if (!(error instanceof Error) || error.message !== 'DMAP remote is not paired') throw error;
      }
      try { await delay(500, undefined, { signal: cancellation.signal }); } catch { cancellation.signal.throwIfAborted(); }
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    await pairing.close();
  }

  const record: DeviceRecord = store.get(device.deviceId) ?? { key: device.deviceId, aliases: deviceAliases(device) };
  record.credentials = { ...record.credentials, dmap: { guid } };
  store.upsert(record);
  await store.save();
  console.log(`Paired! Pairing GUID saved to ${STORAGE_FILE}`);
}

/** `atv dmap <command|state> [device]`: log in with a stored GUID, then close. */
async function cmdDmap(command: keyof typeof DMAP_COMMANDS | 'state', deviceId?: string) {
  const operation = command === 'state' ? 'getNowPlaying' : DMAP_COMMANDS[command];
  const client = await connectSession(deviceId, [operation], 'dmap');
  try {
    if (command === 'state') console.log((await client.execute('getNowPlaying')).toString());
    else { await client.execute(DMAP_COMMANDS[command]); console.log(`Sent: ${command}`); }
  } finally {
    await client.close();
  }
}

/** Browse `_raop._tcp` for up to 5 s and return the port and normalized TXT of the service at `address`. */
function findRaopService(address: string, signal?: AbortSignal): Promise<{ port: number; txt: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const bonjour = new Bonjour(); let found: Service | undefined; let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); browser.stop(); bonjour.destroy();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (found) resolve({ port: found.port, txt: normalizeTxt(found.txt) });
      else reject(new Error(`No _raop._tcp service found at ${address}`));
    };
    const browser = bonjour.find({ type: 'raop', protocol: 'tcp' }, (service: Service) => {
      if (!found && service.port && service.addresses?.includes(address)) { found = service; setImmediate(finish); }
    });
    const timer = setTimeout(finish, 5000);
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('RAOP aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * `atv raop-stream <ipv4> <file-or-url> [--device <paired-selector>]` (experimental): adapt
 * finite audio to PCM16LE stereo 44.1 kHz before streaming it to a RAOP receiver. Tag-readable
 * local files can provide metadata, artwork, and duration. AirPlay 2 requires an explicit paired
 * device selector; Ctrl+C tears both source and RAOP down.
 */
async function cmdRaopStream(address: string, input: string, deviceSelector?: string) {
  const remote = /^https?:\/\//i.test(input) || /^pcm:https?:\/\//i.test(input);
  if (!remote && !existsSync(input)) throw new Error(`No such file: ${input}`);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('RAOP aborted'));
  process.once('SIGINT', cancel);
  let source: RaopInput | undefined;
  try {
    // Start ffmpeg before discovery so a missing dependency cannot establish a playback session.
    source = await openRaopInput(input, cancellation.signal);
    const extracted = source.metadataFile ? await extractRaopMetadata(source.metadataFile) : undefined;
    const metadata = extracted && Object.keys(extracted.metadata).length ? extracted.metadata : undefined;
    console.error(`Resolving _raop._tcp at ${address}...`);
    const discovery = findRaopService(address, cancellation.signal);
    const { port, txt } = source.failure
      ? await Promise.race([discovery, source.failure.then((error) => { cancellation.abort(error); throw error; })])
      : await discovery;
    const sender = new RaopStream(address, port, txt);
    if (deviceSelector !== undefined && sender.profile !== 'airplay2') {
      throw new Error('--device requires an AirPlay 2 receiver; HAP credentials cannot authenticate legacy RAOP');
    }
    let credentials: HAPCredentials | undefined;
    if (sender.profile === 'airplay2') {
      if (!deviceSelector) throw new Error('AirPlay 2 RAOP requires --device <paired-selector> with stored AirPlay credentials');
      const record = await loadRecord(deviceSelector, 'airplay');
      credentials = (await storage()).hap(record.key, 'airplay');
      if (!credentials) throw new Error(`No stored AirPlay credentials for "${deviceSelector}"`);
    }
    console.error(`Streaming ${input} to ${address}:${port} (Ctrl+C to stop)...`);
    await sender.stream(source.source, {
      signal: cancellation.signal,
      ...(credentials === undefined ? {} : { credentials }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(extracted?.duration === undefined ? {} : { duration: extracted.duration }),
    });
    console.log('Stream complete.');
  } finally {
    source?.close();
    process.removeListener('SIGINT', cancel);
  }
}

/** Print the CLI syntax; no discovery or credential loading occurs. */
function help(): void {
  console.log(`Usage:
  atv scan [--host <ip>]...         # find Apple TVs; query known mDNS hosts directly too
  atv pair | companion-pair
  atv command <key> [action] [device]  Send a routed key or Companion button (alias: cmd);
                                       action: singleTap (default), doubleTap, hold
                                       (case-insensitive)
  atv stop [device]
  atv seek <seconds> [device]          Absolute position, >= 0
  atv skip-forward <seconds> [device]  Positive interval
  atv skip-backward <seconds> [device] Positive interval
  atv shuffle <off|albums|songs> [device]
  atv repeat <off|track|all> [device]
  atv volume <0..100> [device]
  atv text <set|append> <text> [device] Quote text, including "" for empty text
  atv text clear [device]
  atv text focus [device]              Print focused, unfocused, or unknown
  atv app list [device]
  atv app launch <bundle-id-or-url> [device]
  atv account list [device]
  atv account switch <account-id> [device]
  atv power [device]                   Print on, off, or unknown
  atv click [action] [device]          Companion touch click; action as for command
  atv swipe <x1> <y1> <x2> <y2> <ms> [device]
                                       Companion swipe; integer coordinates 0..1000, 1..60000 ms
  atv output list [device]             Selected outputs (tab-separated ID and name)
  atv output <add|remove|set> <id[,id...]> [device]
                                       ID = the receiver's AirPlay "psi" UUID, shown by "atv scan";
                                       its deviceid (MAC) or pi will time out
  atv dmap-pair <local-ipv4>           Pair a legacy (DMAP) Apple TV; address is THIS computer's
  atv dmap <command|state> [device]    Legacy DMAP control: ${Object.keys(DMAP_COMMANDS).join(', ')}
  atv raop-stream <ipv4> <file-or-url> [--device <paired-selector>]
                                       Experimental: PCM16LE .pcm; compatible .wav; otherwise ffmpeg
                                       decodes/resamples local files and HTTP(S) URLs (pcm:https://... is raw PCM)
  atv --json <command> ...          Emit versioned JSON Lines (supports watch [device])
  atv watch [device]                Stream normalized state until interrupted
  atv remote | state | queue | messages | keyboard | companion-test [device]
  atv artwork [device] [output.jpg]
  atv help | --help | -h

Remote keys (provider-dependent): ${COMMAND_NAMES.join(', ')}
Companion buttons: ${Object.keys(COMPANION_BUTTONS).join(', ')}`);
}

/** Enforce required arguments and a single optional device before any I/O. */
function argumentsFor(args: string[], required: number, usage: string): void {
  if (args.length < required || args.length > required + 1 ||
      args.some((arg) => !arg.trim())) {
    throw new Error(`Usage: atv ${usage}`);
  }
}

/** Parse a complete finite decimal, rejecting partial numbers and out-of-range values. */
function numberArgument(value: string, min: number, max = Infinity, positive = false): number {
  const number = Number(value);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(number) ||
      number < min || number > max || (positive && number === 0)) {
    throw new Error(`Invalid numeric argument: ${value}`);
  }
  return number;
}

const JSON_VERSION = 1;

type JsonRecord = {
  version: typeof JSON_VERSION;
  type: 'result' | 'event' | 'error';
  command: string;
  timestamp: string;
  deviceId?: string;
  data: Record<string, unknown>;
};

interface JsonCommandResult { data: Record<string, unknown>; deviceId?: string }
interface JsonOperationContext {
  signal: AbortSignal;
  select(id: string): void;
  register(client: DeviceSession): void;
}

function commandFailure(error: unknown, client: DeviceSession): never {
  const id = commandDeviceIds.get(client);
  if (error && typeof error === 'object' && id) commandErrorDeviceIds.set(error, id);
  throw error;
}

class JsonOutputError extends Error {}
class JsonOutputStalledError extends JsonOutputError {}
class JsonOutputLimitError extends Error {}

/** Bounded complete JSON lines; only queued replaceable state is evicted under backpressure. */
class JsonLineWriter {
  private queue: { line: string; bytes: number; key?: string }[] = [];
  private queueBytes = 0;
  private closed = false;
  private failure?: Error;
  private draining?: Promise<void>;
  private finishing?: Promise<void>;
  private cancelWrite?: (error: Error) => void;
  private closedHandler?: () => void;
  private readonly failed = (error: unknown) => this.fail(error);
  private readonly outputClosed = () => this.fail(new Error('Output closed'));

  constructor() {
    process.stdout.on('error', this.failed);
    process.stdout.on('close', this.outputClosed);
  }

  write(record: JsonRecord, key?: string, terminal = false): void {
    if (this.closed) return;
    let line: string;
    try { line = `${JSON.stringify(record)}\n`; } catch (error) { this.fail(error); return; }
    const bytes = Buffer.byteLength(line);
    if (bytes > 1024 * 1024) { this.fail(new JsonOutputLimitError('JSON record exceeds 1 MiB')); return; }
    terminal ||= record.type !== 'event';
    const full = () => this.queue.length >= 128 || this.queueBytes > 1024 * 1024 - bytes;
    if (full()) {
      if (key) {
        const previous = this.queue.findIndex(entry => entry.key === key);
        if (previous >= 0) this.queueBytes -= this.queue.splice(previous, 1)[0].bytes;
      }
      while (full()) {
        const replaceable = this.queue.findIndex(entry => entry.key !== undefined);
        if (replaceable < 0) break;
        this.queueBytes -= this.queue.splice(replaceable, 1)[0].bytes;
      }
      if (full()) {
        if (key && !terminal) return;
        this.fail(new JsonOutputLimitError('JSON output queue exceeds its bounded capacity')); return;
      }
    }
    this.queue.push({ line, bytes, key });
    this.queueBytes += bytes;
    this.start();
  }

  private start(): void {
    if (this.draining || this.closed) return;
    const task = this.drain();
    this.draining = task;
    void task.then(() => {
      if (this.draining === task) this.draining = undefined;
      if (this.queue.length && !this.closed) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const { line, bytes } = this.queue.shift()!;
      this.queueBytes -= bytes;
      try {
        // One outstanding write bounds the stream buffer; its callback also covers asynchronous EPIPE.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.cancelWrite = undefined;
            if (error) reject(error); else resolve();
          };
          const timer = setTimeout(() => {
            this.fail(new JsonOutputStalledError('JSON output did not drain within 2000ms'));
          }, 2000);
          this.cancelWrite = error => settle(error);
          try { process.stdout.write(line, settle); } catch (error) {
            settle(error instanceof Error ? error : new Error('JSON output failed'));
          }
        });
      } catch (error) { this.fail(error); }
    }
  }

  private fail(cause: unknown): void {
    if (this.failure) return;
    this.failure = cause instanceof JsonOutputError || cause instanceof JsonOutputLimitError
      ? cause : new JsonOutputError('JSON output is unavailable', { cause });
    this.closed = true;
    this.queue = [];
    this.queueBytes = 0;
    this.cancelWrite?.(this.failure);
    this.closedHandler?.();
  }

  onClosed(handler?: () => void): void {
    this.closedHandler = handler;
    if (this.failure) handler?.();
  }

  finish(): Promise<void> {
    return this.finishing ??= this.complete();
  }

  private async complete(): Promise<void> {
    while (this.draining || (this.queue.length && !this.closed)) {
      if (!this.draining) this.start();
      await this.draining;
    }
    // Absorb a stream error scheduled after its write callback before detaching the observer.
    await new Promise<void>(resolve => setImmediate(resolve));
    process.stdout.removeListener('error', this.failed);
    process.stdout.removeListener('close', this.outputClosed);
    this.closed = true;
    if (this.failure) throw this.failure;
  }
}

function jsonRecord(type: JsonRecord['type'], command: string, data: Record<string, unknown>, deviceId?: string): JsonRecord {
  return { version: JSON_VERSION, type, command, timestamp: new Date().toISOString(), ...(deviceId ? { deviceId } : {}), data };
}

function playbackData(info: NowPlayingInfo): Record<string, unknown> {
  const states: Record<number, string> = {
    [PlaybackState.Unknown]: 'unknown', [PlaybackState.Playing]: 'playing',
    [PlaybackState.Paused]: 'paused', [PlaybackState.Stopped]: 'stopped',
    [PlaybackState.Interrupted]: 'interrupted', [PlaybackState.Seeking]: 'seeking',
  };
  return {
    hasPlayback: info.hasPlayback, playerIdentifier: info.playerIdentifier || null,
    title: info.title || null, artist: info.artist || null, album: info.album || null,
    genre: info.genre || null,
    duration: info.hasDuration ? info.duration : null,
    elapsedTime: info.hasElapsedTime ? info.elapsedTime : null,
    playbackRate: info.hasPlaybackRate ? info.playbackRate : null,
    playbackState: states[info.playbackState] ?? 'unknown',
    appDisplayName: info.appDisplayName || null, appBundleIdentifier: info.appBundleIdentifier || null,
  };
}

function jsonError(error: unknown): Record<string, unknown> {
  const detail = error instanceof Error ? error.message : '';
  const protocol = error && typeof error === 'object' && 'errorCode' in error ? error.errorCode : undefined;
  let code = 'operation_failed';
  let message = 'Operation failed';
  if (error instanceof JsonOutputLimitError) { code = 'output_limit'; message = error.message; }
  else if (/Unsupported in JSON mode/i.test(detail)) { code = 'unsupported'; message = detail; }
  else if (/No text field is focused|not focused/i.test(detail)) { code = 'text_unfocused'; message = 'No text field is focused'; }
  // "No configured implementation": no stored pairing's protocol can perform the operation.
  else if (error instanceof SyntaxError || /credentials|paired device|No configured implementation/i.test(detail)) {
    code = 'credentials_unavailable'; message = 'Pairing credentials are unavailable or invalid';
  } else if (/Usage:|Unknown command|Invalid |must be |nonblank|unsupported|selector is ambiguous/i.test(detail)) {
    code = 'invalid_arguments'; message = 'Invalid command arguments';
  } else if (typeof protocol === 'number' && Number.isSafeInteger(protocol)) {
    code = 'protocol_error'; message = 'Device rejected the operation';
  } else if (/timeout|timed out|closed|ECONN|EHOST|ENET/i.test(detail)) {
    code = 'transport_error'; message = 'Control transport failed';
  }
  return { code, message, ...(typeof protocol === 'number' && Number.isSafeInteger(protocol) ? { protocolCode: protocol } : {}) };
}

async function cmdJsonWatch(deviceId: string | undefined, writer: JsonLineWriter): Promise<void> {
  const controller = new AbortController();
  let id: string | undefined;
  let atv: DeviceSession | undefined;
  let terminal = false;
  let closing: Promise<void> | undefined;
  const removers: Array<() => void> = [];
  const ready = new Set<ControlProtocol>();
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const emit = (name: string, data: Record<string, unknown>, key?: string) => {
    if (!terminal) writer.write(jsonRecord('event', name, data, id), key);
  };
  const stop = (name: string, data: Record<string, unknown>, exitCode: number, output = true) => {
    if (terminal) return;
    terminal = true;
    controller.abort();
    if (output) writer.write(jsonRecord('event', name, data, id), undefined, true);
    process.exitCode = exitCode;
    resolveDone();
    closing = atv?.close() ?? Promise.resolve();
  };
  const interrupt = () => stop('watch-close', { reason: 'signal', signal: 'SIGINT', intentional: true }, 130);
  const terminate = () => stop('watch-close', { reason: 'signal', signal: 'SIGTERM', intentional: true }, 143);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  writer.onClosed(() => stop('watch-close', { reason: 'stdout_closed', intentional: true }, 1, false));
  let observedPlayback = false;
  let observedOutputs = false;
  let observedVolume = false;
  let observedPower = false;
  let observedFocus = false;
  try {
    const client = await connectSession(deviceId, undefined, undefined, {
      signal: controller.signal,
      select: key => { id = key; },
      register: session => {
        atv = session;
        const listen = <Args extends unknown[]>(event: string, handler: (...args: Args) => void) => {
          session.on(event, handler); removers.push(() => session.removeListener(event, handler));
        };
        listen('connection', ({ protocol, state }: { protocol: ControlProtocol; state: string }) => {
          if (state === 'lost') stop('connection-close', { intentional: false, transport: protocol === 'airplay' ? 'mrp' : protocol }, 1);
          else if (state === 'ready') {
            ready.add(protocol);
            emit('connection', { transport: protocol === 'airplay' ? 'mrp' : protocol, state: 'connected' });
          }
        });
        listen('transportError', ({ error, protocol }: { error: Error; protocol: ControlProtocol }) => emit('connection-error', jsonError(error), `${protocol}-error`));
        listen('nowPlaying', (info: NowPlayingInfo) => { observedPlayback = true; emit('playback', playbackData(info), 'playback'); });
        listen('volume', (volume: number | undefined) => {
          observedVolume = true;
          const known = typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 100;
          emit('volume', { value: known ? volume : null, state: known ? 'known' : 'unknown' }, 'volume');
        });
        listen('outputDevices', (outputs: { identifier: string; name: string }[]) => {
          observedOutputs = true;
          emit('output-devices', { devices: outputs.map(output => ({ id: output.identifier, name: output.name })), state: 'known' }, 'outputs');
        });
        listen('keyboard', (info: KeyboardInfo) => {
          if (!ready.has('companion')) { observedFocus = true; emit('text-focus', { state: info.focused ? 'focused' : 'unfocused' }, 'focus'); }
        });
        listen('powerState', (state: string) => { observedPower = true; emit('power', { state }, 'power'); });
        listen('textFocusState', (state: string) => { observedFocus = true; emit('text-focus', { state }, 'focus'); });
      },
    }, false);
    if (terminal) return;
    const hasMRP = ready.has('airplay') || ready.has('mrp');
    if (!hasMRP) emit('source', { source: 'mrp', state: 'unavailable' });
    if (!observedPlayback) emit('playback', { state: 'unknown' }, 'playback');
    if (!observedVolume) emit('volume', { value: client.volume ?? null, state: client.volume === undefined ? hasMRP ? 'unknown' : 'unavailable' : 'known' }, 'volume');
    if (!observedOutputs) emit('output-devices', { devices: null, state: hasMRP ? 'unknown' : 'unavailable' }, 'outputs');
    if (ready.has('companion')) {
      await client.execute('subscribePowerState');
      if (terminal) return;
      if (!observedFocus) emit('text-focus', { state: client.textFocusState }, 'focus');
    } else {
      emit('source', { source: 'companion', state: 'unavailable' });
      if (!observedFocus) emit('text-focus', { state: 'unknown', available: hasMRP }, 'focus');
    }
    if (!observedPower) {
      const data = hasMRP || ready.has('companion')
        ? { state: client.powerState } : { state: 'unknown', available: false };
      emit('power', data, 'power');
    }
    await done;
  } catch (error) {
    if (!terminal) {
      terminal = true;
      if (error && typeof error === 'object' && id) commandErrorDeviceIds.set(error, id);
      throw error;
    }
  } finally {
    terminal = true;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    writer.onClosed();
    await (closing ?? atv?.close());
    for (const remove of removers) remove();
  }
}

async function mainJson(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const writer = new JsonLineWriter();
  const controller = new AbortController();
  let active: DeviceSession | undefined;
  let selectedId: string | undefined;
  let cancelled = false;
  const cancel = (exitCode: number, signal?: string) => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    process.exitCode = exitCode;
    if (signal) writer.write(jsonRecord('error', command ?? 'unknown', { code: 'cancelled', message: 'Command cancelled', signal }, selectedId), undefined, true);
    void active?.close();
  };
  const interrupt = () => cancel(130, 'SIGINT');
  const terminate = () => cancel(143, 'SIGTERM');
  try {
    if (!command || ['help', '--help', '-h'].includes(command)) {
      writer.write(jsonRecord('result', 'help', { schemaVersion: JSON_VERSION }));
      return;
    }
    if (['pair', 'companion-pair', 'dmap-pair', 'dmap', 'remote', 'messages', 'keyboard', 'companion-test', 'raop-stream'].includes(command)) {
      throw new Error(`Unsupported in JSON mode: ${command}`);
    }
    if (command === 'watch') {
      argumentsFor(args, 0, 'watch [device]');
      await cmdJsonWatch(args[0], writer);
      return;
    }
    writer.onClosed(() => cancel(1));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    if (command === 'scan') {
      const hosts = scanHosts(args);
      const devices = await scan({ timeout: 5000, hosts, signal: controller.signal });
      if (!cancelled) writer.write(jsonRecord('result', 'scan', { devices: devices.map(device => ({
        id: device.deviceId, name: device.name, address: device.address, port: device.port, model: device.model, psi: device.airplayPsi ?? null,
      })) }));
      return;
    }
    const context: JsonOperationContext = {
      signal: controller.signal,
      select: id => { selectedId = id; },
      register: client => { active = client; },
    };
    const result = await main(argv, true, context);
    if (cancelled) return;
    if (!result) throw new Error('JSON command produced no result');
    writer.write(jsonRecord('result', command, result.data, result.deviceId));
  } catch (error) {
    if (!cancelled) {
      if (error && typeof error === 'object' && selectedId) commandErrorDeviceIds.set(error, selectedId);
      throw error;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    writer.onClosed();
    await active?.close();
    await writer.finish();
  }
}

/** Validate and dispatch CLI arguments. Errors propagate to the executable's exit handler. */
export async function main(argv: string[], jsonInternal = false, context?: JsonOperationContext): Promise<JsonCommandResult | void> {
  if (!jsonInternal) {
    cliStore = undefined;
    const jsonIndexes = argv.reduce<number[]>((indexes, value, index) => value === '--json' ? [...indexes, index] : indexes, []);
    if (jsonIndexes.length > 1) {
      const writer = new JsonLineWriter();
      writer.write(jsonRecord('error', argv.find((value) => value !== '--json') ?? 'unknown', {
        code: 'invalid_arguments', message: '--json may be specified once',
      }));
      await writer.finish();
      process.exitCode = 1;
      return;
    }
    if (jsonIndexes.length === 1) {
      const jsonArgv = argv.filter((_, index) => index !== jsonIndexes[0]);
      try {
        await mainJson(jsonArgv);
      } catch (error) {
        process.exitCode = 1;
        if (error instanceof JsonOutputStalledError) throw error;
        if (error instanceof JsonOutputError) return;
        const writer = new JsonLineWriter();
        const id = error && typeof error === 'object' ? commandErrorDeviceIds.get(error) : undefined;
        writer.write(jsonRecord('error', jsonArgv[0] ?? 'unknown', jsonError(error), id));
        await writer.finish();
        process.exitCode = 1;
      }
      return;
    }
  }
  const [cmd, ...args] = argv;
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { help(); return; }
  let selectedOperation: SessionOperation;
  // Queries get a reply; every other operation ends with an unacknowledged send (HID key, `_tiC`, ...).
  let acknowledged = false;
  let waitAfterSend = true;
  let device: string | undefined;
  let operation: (atv: DeviceSession) => Promise<void | string | App[] | UserAccount[]>;
  switch (cmd) {
    case 'command': case 'cmd': {
      const { action, rest } = splitAction(args, 1);
      argumentsFor(rest, 1, 'command <key> [action] [device]');
      const result = await cmdCommand(rest[0], action, rest[1], jsonInternal, context);
      return jsonInternal ? result : undefined;
    }
    case 'click': {
      const { action, rest } = splitAction(args, 0);
      argumentsFor(rest, 0, 'click [action] [device]');
      device = rest[0]; selectedOperation = 'click';
      operation = (atv) => atv.execute('click', action);
      break;
    }
    case 'swipe': {
      argumentsFor(args, 5, 'swipe <x1> <y1> <x2> <y2> <ms> [device]');
      const [x1, y1, x2, y2, ms] = args.slice(0, 5).map((value, i) => {
        const number = numberArgument(value, i < 4 ? 0 : 1, i < 4 ? 1000 : 60000);
        if (!Number.isInteger(number)) throw new Error(`Invalid numeric argument: ${value}`);
        return number;
      });
      device = args[5]; selectedOperation = 'swipe';
      operation = (atv) => atv.execute('swipe', x1, y1, x2, y2, ms);
      break;
    }
    case 'output': {
      const [action, ...values] = args;
      // Routing resolves only once the TV reports the new group, so no post-send wait is needed.
      acknowledged = true; waitAfterSend = false;
      // Rows reuse the printer's `id\tname` format.
      const rows = (atv: DeviceSession) => atv.outputDevices.map((d) => ({ id: d.identifier, name: d.name }));
      if (action === 'list') {
        argumentsFor(values, 0, 'output list [device]');
        device = values[0]; selectedOperation = 'requestPlaybackQueue';
        operation = async (atv) => rows(atv);
      } else if (Object.hasOwn(OUTPUT_METHODS, action ?? '')) {
        const usage = `output ${action} <id[,id...]> [device]`;
        argumentsFor(values, 1, usage);
        const ids = values[0].split(',').map((id) => id.trim());
        if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
          throw new Error(`Usage: atv ${usage} (IDs must be unique and nonblank)`);
        }
        device = values[1];
        const method = OUTPUT_METHODS[action as keyof typeof OUTPUT_METHODS];
        selectedOperation = method;
        operation = async (atv) => { await atv.execute(method, ids); return rows(atv); };
      } else throw new Error(`Invalid output operation: ${action ?? '(missing)'}`);
      break;
    }
    case 'dmap': {
      argumentsFor(args, 1, 'dmap <command|state> [device]');
      if (args[0] !== 'state' && !Object.hasOwn(DMAP_COMMANDS, args[0])) throw new Error(`Unknown DMAP command: ${args[0]}`);
      return cmdDmap(args[0] as keyof typeof DMAP_COMMANDS | 'state', args[1]);
    }
    case 'dmap-pair':
      if (args.length !== 1 || !isIPv4(args[0])) throw new Error('Usage: atv dmap-pair <local-ipv4>');
      return cmdDmapPair(args[0]);
    case 'raop-stream': {
      const selector = args.length === 4 && args[2] === '--device' ? args[3] : undefined;
      if ((args.length !== 2 && selector === undefined) || !isIPv4(args[0]) || !args[1]?.trim() || selector !== undefined && !selector.trim()) {
        throw new Error('Usage: atv raop-stream <ipv4> <file-or-url> [--device <paired-selector>]');
      }
      return cmdRaopStream(args[0], args[1], selector);
    }
    case 'stop': case 'power':
      argumentsFor(args, 0, `${cmd} [device]`);
      device = args[0]; acknowledged = true; waitAfterSend = cmd !== 'power';
      selectedOperation = cmd === 'stop' ? 'stop' : 'fetchPowerState';
      operation = cmd === 'stop' ? (atv) => atv.execute('stop') : (atv) => atv.execute('fetchPowerState');
      break;
    case 'seek': case 'skip-forward': case 'skip-backward': case 'volume': {
      argumentsFor(args, 1, `${cmd} <number> [device]`);
      const value = numberArgument(args[0], 0, cmd === 'volume' ? 100 : Infinity, cmd.startsWith('skip-'));
      device = args[1];
      acknowledged = cmd !== 'volume';
      selectedOperation = cmd === 'seek' ? 'setPosition' : cmd === 'volume' ? 'setVolume' :
        cmd === 'skip-forward' ? 'skipForward' : 'skipBackward';
      operation = (atv) => atv.execute(selectedOperation as 'setPosition' | 'setVolume' | 'skipForward' | 'skipBackward', value);
      break;
    }
    case 'shuffle': case 'repeat': {
      argumentsFor(args, 1, `${cmd} <mode> [device]`);
      const shuffle: Record<string, ShuffleState> = { off: ShuffleState.Off, albums: ShuffleState.Albums, songs: ShuffleState.Songs };
      const repeat: Record<string, RepeatState> = { off: RepeatState.Off, track: RepeatState.Track, all: RepeatState.All };
      if (!Object.hasOwn(cmd === 'shuffle' ? shuffle : repeat, args[0])) throw new Error(`Invalid ${cmd} mode: ${args[0]}`);
      device = args[1];
      acknowledged = true;
      selectedOperation = cmd === 'shuffle' ? 'setShuffle' : 'setRepeat';
      operation = (atv) => cmd === 'shuffle' ? atv.execute('setShuffle', shuffle[args[0]]) : atv.execute('setRepeat', repeat[args[0]]);
      break;
    }
    case 'text': {
      const [action, ...values] = args;
      if (action === 'clear') {
        argumentsFor(values, 0, 'text clear [device]');
        device = values[0]; selectedOperation = 'clearText'; operation = (atv) => atv.execute('clearText');
      } else if (action === 'focus') {
        argumentsFor(values, 0, 'text focus [device]');
        device = values[0]; acknowledged = true; waitAfterSend = false; selectedOperation = 'fetchTextFocusState';
        operation = (atv) => atv.execute('fetchTextFocusState');
      } else if (action === 'set' || action === 'append') {
        // Empty text is valid; unlike identifiers it must not be trimmed or rejected.
        if (values.length < 1 || values.length > 2 || (values[1] !== undefined && !values[1].trim())) throw new Error(`Usage: atv text ${action} <text> [device]`);
        device = values[1];
        selectedOperation = action === 'set' ? 'setText' : 'insertText';
        operation = (atv) => action === 'set' ? atv.execute('setText', values[0]) : atv.execute('insertText', values[0]);
      } else throw new Error('Usage: atv text <set|append|clear|focus> ...');
      break;
    }
    case 'app': case 'account': {
      const [action, ...values] = args;
      if (action === 'list') {
        argumentsFor(values, 0, `${cmd} list [device]`);
        device = values[0]; acknowledged = true; waitAfterSend = false;
        selectedOperation = cmd === 'app' ? 'appList' : 'accountList';
        operation = (atv) => cmd === 'app' ? atv.execute('appList') : atv.execute('accountList');
      } else if (action === (cmd === 'app' ? 'launch' : 'switch')) {
        argumentsFor(values, 1, `${cmd} ${action} <id> [device]`);
        device = values[1];
        acknowledged = true;
        selectedOperation = cmd === 'app' ? 'launchApp' : 'switchAccount';
        operation = (atv) => cmd === 'app' ? atv.execute('launchApp', values[0]) : atv.execute('switchAccount', values[0]);
      } else throw new Error(`Invalid ${cmd} operation: ${action ?? '(missing)'}`);
      break;
    }
    case 'scan': return cmdScan(scanHosts(args));
    case 'pair': case 'companion-pair':
      if (args.length) throw new Error(`Usage: atv ${cmd}`);
      if (jsonInternal) throw new Error(`Unsupported in JSON mode: ${cmd}`);
      return cmd === 'pair' ? cmdPair() : cmdCompanionPair();
    case 'remote': case 'state': case 'queue': case 'messages': case 'keyboard': case 'companion-test':
      argumentsFor(args, 0, `${cmd} [device]`);
      if (cmd === 'state') {
        const result = await cmdState(args[0], jsonInternal, context);
        return jsonInternal ? result : undefined;
      }
      if (cmd === 'queue') {
        const result = await cmdQueue(args[0], jsonInternal, context);
        return jsonInternal ? result : undefined;
      }
      if (jsonInternal) throw new Error(`Unsupported in JSON mode: ${cmd}`);
      switch (cmd) {
        case 'remote': return cmdRemote(args[0]);
        case 'messages': return cmdMessages(args[0]);
        case 'keyboard': return cmdKeyboard(args[0]);
        case 'companion-test': return cmdCompanionTest(args[0]);
      }
      return;
    case 'artwork':
      if (args.length > 2) throw new Error('Usage: atv artwork [device] [output.jpg]');
      {
        const result = await cmdArtwork(args[0], args[1], jsonInternal, context);
        return jsonInternal ? result : undefined;
      }
    default: throw new Error(`Unknown command: ${cmd}. Run "atv --help".`);
  }
  const atv = await connectSession(device, [selectedOperation], undefined, context);
  try {
    context?.signal.throwIfAborted();
    const result = await operation(atv);
    // Give unacknowledged sends time to reach the TV before close() destroys the socket.
    if (waitAfterSend) await delay(postSendMs(), undefined, { signal: context?.signal });
    if (jsonInternal) {
      const data = Array.isArray(result)
        ? { items: result.map((item) => 'bundleId' in item ? { id: item.bundleId, name: item.name } : { id: item.id, name: item.name }), acknowledged }
        : result === undefined ? { acknowledged } : { value: result, acknowledged };
      return { data, deviceId: commandDeviceIds.get(atv) ?? atv.device.deviceId };
    }
    if (Array.isArray(result)) {
      for (const item of result) console.log(`${'bundleId' in item ? item.bundleId : item.id}\t${item.name}`);
    } else if (result !== undefined) console.log(result);
  } catch (error) { commandFailure(error, atv); } finally {
    await atv.close();
  }
}

// Importing the CLI for tests does not execute commands or touch stored credentials.
// realpathSync resolves npm bin symlinks; an unresolvable argv[1] just means "not the script".
let isScript = false;
try { isScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* not the script */ }
if (isScript) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Node cannot destroy its special stdout stream while a pipe write is pending.
    // The command has already awaited owned-transport cleanup; only the executable may force exit.
    if (error instanceof JsonOutputStalledError) process.exit(1);
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
