#!/usr/bin/env node
/**
 * `atv` command-line tool: scan, pair, control playback/text, touch, output routing and Companion,
 * inspect now-playing, keyboard, and Companion events, control legacy DMAP Apple TVs, and stream raw
 * PCM to legacy RAOP receivers (experimental). Pairings and endpoint hints use the
 * public versioned FileStorage API; legacy CLI JSON is imported once without deletion.
 */
import { scan, normalizeTxt, type DiscoveredDeviceInfo } from '../discovery.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AppleTV, Key, ShuffleState, RepeatState, contentItems, INPUT_ACTIONS } from '../appletv.js';
import { PlaybackState } from '../now-playing-info.js';
import { MessageType, HID_KEY_MAP } from '../mrp/messages.js';
import { Credentials } from '../credentials.js';
import { FileStorage, type DeviceRecord, type EndpointHints } from '../storage.js';
import { DmapClient } from '../dmap/client.js';
import { DmapPairing } from '../dmap/pairing.js';
import { RaopStream } from '../raop/stream.js';
import { Bonjour, type Service } from 'bonjour-service';
import { readFileSync, writeFileSync, existsSync, realpathSync, createReadStream } from 'node:fs';
import { isIPv4 } from 'node:net';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import type { Message } from '../message.js';
import type { KeyboardInfo, TextInputEvent, CompanionEvent, App, UserAccount, InputAction } from '../appletv.js';

/** Versioned CLI state. Plaintext storage is protected by restrictive file permissions, not a keychain. */
const STORAGE_FILE = join(process.env.HOME ?? '.', '.atv-storage.json');
const CREDS_FILE = join(process.env.HOME ?? '.', '.atv-credentials.json');
const DMAP_FILE = join(process.env.HOME ?? '.', '.atv-dmap.json');
const DEVICES_FILE = join(process.env.HOME ?? '.', '.atv-devices.json');
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
        store.setUnclassifiedHap(key, credentials, [key]);
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
async function cmdScan() {
  console.log('Scanning for Apple TVs...');
  const devices = await scan({ timeout: 5000 });
  if (devices.length === 0) {
    console.log('No Apple TVs found.');
    return;
  }
  devices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name} (${d.address}:${d.port}) [${d.model}]${d.airplayPsi ? ` psi=${d.airplayPsi}` : ''}`);
  });
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

/** Select a stored record with credentials for `protocol`, without ambiguous alias fallback. */
async function loadRecord(protocol: 'airplay' | 'companion' | 'dmap', deviceId?: string) {
  if (deviceId !== undefined && !deviceId.trim()) throw new Error('Device selector must be nonblank');
  const records = (await storage()).records().filter(record => Boolean(record.credentials?.[protocol]));
  if (records.length === 0) throw new Error(`No credentials found. Run "atv ${protocol === 'dmap' ? 'dmap-pair' : 'pair'}" first.`);
  const record = deviceId === undefined ? records[records.length - 1] : records.find(r => r.key.toLowerCase().includes(deviceId.toLowerCase()));
  if (!record) throw new Error(`No paired device matches "${deviceId}"`);
  return record;
}

/** Load a typed modern credential; old unclassified imports intentionally require re-pairing. */
async function loadCredentials(deviceId?: string): Promise<{ id: string; protocol: 'airplay' | 'mrp'; credentials: Credentials }> {
  if (deviceId !== undefined && !deviceId.trim()) throw new Error('Device selector must be nonblank');
  const store = await storage();
  const records = store.records().filter(record => Boolean(record.credentials?.airplay || record.credentials?.mrp));
  if (records.length === 0) throw new Error('No typed AirPlay/MRP credentials found. Re-pair this device to classify its transport.');
  const record = deviceId === undefined ? records[records.length - 1] : records.find(r => r.key.toLowerCase().includes(deviceId.toLowerCase()));
  if (!record) throw new Error(`No paired device matches "${deviceId}"`);
  const protocol = record.credentials?.airplay ? 'airplay' : 'mrp';
  const credential = store.hap(record.key, protocol)!;
  return { id: record.key, protocol, credentials: { ...credential, companionCredentials: store.hap(record.key, 'companion') } as Credentials };
}

/**
 * Scan (stopping early once found) and return the device whose ID equals or contains `id`, or whose name contains it (case-insensitive).
 * @throws if nothing matches; the message lists the devices that were found.
 */
async function findDevice(id: string, need: 'mrp' | 'companion' | 'dmap'): Promise<DiscoveredDeviceInfo> {
  console.error('Finding device...');
  const idLower = id.toLowerCase();
  const matches = (d: DiscoveredDeviceInfo) =>
    d.deviceId.toLowerCase() === idLower ||
    d.identifiers?.some(alias => alias.toLowerCase() === idLower) ||
    d.name.toLowerCase().includes(idLower) ||
    d.deviceId.toLowerCase().includes(idLower);
  // Stop as soon as the device has arrived with the port `need` requires: Companion, DMAP, or an
  // AirPlay/usable MRP port.
  const devices = await scan({ timeout: 5000, until: (d) => matches(d) && (need === 'companion' ? !!d.companionPort :
    need === 'dmap' ? !!d.dmapPort : !!d.port || !!d.mrpPort && d.mrpEnabled !== false) });
  const device = devices.find(matches);
  if (!device) {
    throw new Error(`Device not found on network (looking for "${id}"). Found: ${devices.map((d) => `${d.name} [${d.deviceId}]`).join(', ')}`);
  }
  return device;
}

/** Scan for a device, then retain only nonsecret endpoint hints for the next CLI invocation. */
/** Try a stored nonsecret endpoint hint first, then rescan and refresh it after a successful connection. */
async function connectCached<T>(id: string, need: 'mrp' | 'companion' | 'dmap', connect: (device: DiscoveredDeviceInfo) => Promise<T>): Promise<T> {
  const store = await storage();
  const record = store.get(id);
  const endpointSettings = record?.settings?.[need === 'mrp' ? (record.settings.airplay ? 'airplay' : 'mrp') : need]?.endpoint;
  if (record && (record.hints?.address || endpointSettings?.address)) {
    const hints = { ...record.hints, ...endpointSettings };
    const cached: DiscoveredDeviceInfo = { name: hints.name ?? record.key, deviceId: record.key, model: hints.model ?? '', address: hints.address!, port: hints.port ?? 0, companionAddress: hints.companionAddress, companionPort: hints.companionPort, mrpAddress: hints.mrpAddress, mrpPort: hints.mrpPort, mrpEnabled: hints.mrpEnabled, dmapAddress: hints.dmapAddress, dmapPort: hints.dmapPort, raopAddress: hints.raopAddress, raopPort: hints.raopPort };
    try { return await connect(cached); } catch { /* Stale hints fall through to discovery. */ }
  }
  const device = await findDevice(id, need);
  const result = await connect(device);
  if (record) {
    const hints: EndpointHints = { name: device.name, model: device.model, address: device.address, port: device.port, companionAddress: device.companionAddress, companionPort: device.companionPort, mrpAddress: device.mrpAddress, mrpPort: device.mrpPort, mrpEnabled: device.mrpEnabled, dmapAddress: device.dmapAddress, dmapPort: device.dmapPort, raopAddress: device.raopAddress, raopPort: device.raopPort };
    if (JSON.stringify(record.hints) !== JSON.stringify(hints)) { record.hints = hints; store.upsert(record); await store.save(); }
  }
  return result;
}

/** Load credentials, locate the device, and open an AirPlay/MRP connection. */
async function connectToDevice(deviceId?: string): Promise<AppleTV> {
  const { id, protocol, credentials } = await loadCredentials(deviceId);
  return connectCached(id, 'mrp', async (device) => {
    console.error(`Connecting to ${device.name} (${device.address}:${device.port})...`);
    if ((device.port ? 'airplay' : 'mrp') !== protocol) throw new Error(`Stored ${protocol} credentials do not match the discovered transport`);
    const atv = new AppleTV(device);
    atv.on('error', (err: Error) => console.error(`AirPlay error: ${err.message}`));
    const resolved = (await storage()).resolveConnection(id, protocol);
    try { await atv.connect(credentials, { settleMs: process.env.ATV_SETTLE_MS === undefined ? resolved.settleMs ?? settleMs() : settleMs() }); } catch (e) { await atv.close(); throw e; }
    return atv;
  });
}

/** Load Companion credentials and connect only Companion. */
async function connectToCompanion(deviceId?: string): Promise<AppleTV> {
  const record = await loadRecord('companion', deviceId);
  const companion = (await storage()).hap(record.key, 'companion')!;
  return connectCached(record.key, 'companion', async (device) => {
    if (!device.companionPort) throw new Error('Device has no companion-link port');
    const atv = new AppleTV(device);
    atv.on('companionError', (err: Error) => console.error(`Companion error: ${err.message}`));
    console.error(`Connecting companion to ${device.name} (${device.address}:${device.companionPort})...`);
    try { await atv.connectCompanion(companion); return atv; } catch (error) { await atv.close(); throw error; }
  });
}

/** Companion-only buttons exposed by `command`; no MRP connection is needed. */
const COMPANION_BUTTONS = {
  channel_up: 'channelUp', channel_down: 'channelDown', screensaver: 'screensaver',
  guide: 'guide', page_up: 'pageUp', page_down: 'pageDown',
} as const;

/** One-shot commands implemented by Companion control requests. */
const COMPANION_CONTROL_COMMANDS: Record<string, true> = {
  up: true, down: true, left: true, right: true, select: true, menu: true, home: true,
  play_pause: true, volume_up: true, volume_down: true, play: true, pause: true,
  next: true, previous: true, skip_forward: true, skip_backward: true, wake: true, suspend: true,
};

/**
 * Send a validated key or Companion button, optionally with an action mode, then close even if
 * sending fails. Only HID keys and Companion buttons accept an action; media keys, wake/suspend,
 * skips and `home_hold` are rejected before connecting.
 */
async function cmdCommand(command: string, action?: InputAction, deviceId?: string) {
  const button = Object.hasOwn(COMPANION_BUTTONS, command)
    ? COMPANION_BUTTONS[command as keyof typeof COMPANION_BUTTONS] : undefined;
  const companion = button !== undefined || COMPANION_CONTROL_COMMANDS[command] === true;
  if (!button && !COMMAND_SET.has(command)) throw new Error(`Unknown command: ${command}. Run "atv --help".`);
  if (action && !button && !HID_KEY_MAP[command]) throw new Error(`Action modes are not supported for ${command}`);
  let useCompanion = button !== undefined;
  if (!useCompanion && companion) {
    try { await loadRecord('companion', deviceId); useCompanion = true; } catch { /* MRP remains the fallback when Companion is unpaired. */ }
  }
  const atv = await (useCompanion ? connectToCompanion(deviceId) : connectToDevice(deviceId));
  try {
    // An undefined action takes each method's 'singleTap' default.
    if (button) await atv[button](action);
    else await atv.sendKeyCommand(command as Key, action);
    console.log(`Sent: ${command}`);
    await delay(postSendMs());
  } finally {
    await atv.close();
  }
}

/** `atv remote [device]`: interactive prompt that sends each typed key name. */
async function cmdRemote(deviceId?: string) {
  const companion = Boolean((await loadCredentials(deviceId)).credentials.companionCredentials);
  const atv = await (companion ? connectToCompanion(deviceId) : connectToDevice(deviceId));

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
    } else if (companion && !COMPANION_CONTROL_COMMANDS[input]) {
      console.log(`Error: ${input} requires an MRP connection.`);
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
async function cmdState(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.error('Requesting state...');
    const info = await atv.getNowPlaying();
    const stopped = info.playbackState === PlaybackState.Stopped;
    const idle = !info.hasPlayback && (stopped || info.playbackState === PlaybackState.Unknown);
    console.log(idle ? `Nothing playing. [${stopped ? 'Stopped' : 'Absent'}]` : info.toString());
  } finally {
    await atv.close();
  }
}

/** `atv queue [device]`: print up to 20 items from the playback queue. */
async function cmdQueue(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.error('Requesting playback queue...');
    const response = await atv.requestPlaybackQueue({
      location: 0,
      length: 20,
      includeMetadata: true,
    });
    const items = contentItems(response);
    if (items.length > 0) {
      items.forEach((item, i) => {
        const metadata = item.metadata as Record<string, unknown> | undefined;
        const title = metadata?.title ?? item.identifier ?? '(unknown)';
        console.log(`  ${i + 1}. ${title}`);
      });
    } else {
      console.log('No items in playback queue.');
    }
  } finally {
    await atv.close();
  }
}

/** `atv artwork [device] [file]`: save 600x600 now-playing artwork (default artwork.jpg). */
async function cmdArtwork(deviceId?: string, outputFile?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.error('Requesting artwork...');
    const artwork = await atv.requestArtwork(600, 600);
    if (artwork) {
      const filename = outputFile ?? 'artwork.jpg';
      writeFileSync(filename, artwork);
      console.log(`Artwork saved to ${filename} (${artwork.length} bytes)`);
    } else {
      console.log('No artwork available.');
    }
  } finally {
    await atv.close();
  }
}

/** `atv messages [device]`: print every incoming MRP message until Ctrl+C. */
async function cmdMessages(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
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
  const atv = await connectToCompanion(deviceId);
  console.log('Companion connected! Listening for events (Ctrl+C to stop)...\n');

  atv.on('companionEvent', (event: CompanionEvent) => {
    console.log(`Event: ${event.identifier}`);
    const readable = Object.fromEntries(
      [...event.data].map(([k, v]) => [String(k), v]),
    );
    console.log(`  data: ${JSON.stringify(readable)}`);
  });

  atv.on('companionError', (err: Error) => {
    console.error(`Companion error: ${err.message}`);
  });

  atv.on('companionClose', () => {
    console.log('Companion connection closed.');
  });

  process.on('SIGINT', async () => {
    console.log('\nDisconnecting...');
    await atv.close();
    process.exit(0);
  });
}

/** `atv keyboard [device]`: print keyboard focus and text-input events (plus their raw messages) until Ctrl+C. */
async function cmdKeyboard(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
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
  const record = await loadRecord('dmap', deviceId);
  const guid = record.credentials!.dmap!.guid;
  const client = await connectCached(record.key, 'dmap', async (device) => {
    console.error(`Connecting DMAP to ${device.name} (${device.dmapAddress ?? device.address}:${device.dmapPort})...`);
    const dmap = new DmapClient(device);
    await dmap.connect(guid);
    return dmap;
  });
  try {
    if (command === 'state') console.log((await client.getState()).toString());
    else { await client[DMAP_COMMANDS[command]](); console.log(`Sent: ${command}`); }
  } finally {
    client.close();
  }
}

/** Browse `_raop._tcp` for up to 5 s and return the port and normalized TXT of the service at `address`. */
function findRaopService(address: string): Promise<{ port: number; txt: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const bonjour = new Bonjour();
    let found: Service | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      browser.stop();
      bonjour.destroy();
      if (found) resolve({ port: found.port, txt: normalizeTxt(found.txt) });
      else reject(new Error(`No _raop._tcp service found at ${address}`));
    };
    // Stop on the next tick so a callback fired during find() never touches an unassigned browser.
    const browser = bonjour.find({ type: 'raop', protocol: 'tcp' }, (service: Service) => {
      if (!found && service.port && service.addresses?.includes(address)) { found = service; setImmediate(finish); }
    });
    const timer = setTimeout(finish, 5000);
  });
}

/**
 * `atv raop-stream <ipv4> <file.pcm>` (experimental): stream raw PCM16LE stereo 44.1 kHz to a legacy
 * RAOP receiver via RaopStream. Ctrl+C cancels and tears the session down.
 */
async function cmdRaopStream(address: string, file: string) {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  console.error(`Resolving _raop._tcp at ${address}...`);
  const { port, txt } = await findRaopService(address);
  const sender = new RaopStream(address, port, txt);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error('RAOP aborted'));
  process.once('SIGINT', cancel);
  try {
    console.error(`Streaming ${file} to ${address}:${port} (Ctrl+C to stop)...`);
    await sender.stream(createReadStream(file, { highWaterMark: 65536 }), { signal: cancellation.signal });
    console.log('Stream complete.');
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}

/** Print the CLI syntax; no discovery or credential loading occurs. */
function help(): void {
  console.log(`Usage:
  atv scan | pair | companion-pair
  atv command <key> [action] [device]  Send an MRP key or Companion button (alias: cmd);
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
  atv raop-stream <ipv4> <file.pcm>    Experimental: stream raw PCM16LE stereo 44.1 kHz to a legacy
                                       RAOP receiver (no WAV header, no PIN/HAP receivers)
  atv remote | state | queue | messages | keyboard | companion-test [device]
  atv artwork [device] [output.jpg]
  atv help | --help | -h

MRP keys: ${COMMAND_NAMES.join(', ')}
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

/** Validate and dispatch CLI arguments. Errors propagate to the executable's exit handler. */
export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  if (!cmd || ['help', '--help', '-h'].includes(cmd)) { help(); return; }
  let companion = false;
  // Queries get a reply; every other operation ends with an unacknowledged send (HID key, `_tiC`, ...).
  let acknowledged = false;
  let device: string | undefined;
  let operation: (atv: AppleTV) => Promise<void | string | App[] | UserAccount[]>;
  switch (cmd) {
    case 'command': case 'cmd': {
      const { action, rest } = splitAction(args, 1);
      argumentsFor(rest, 1, 'command <key> [action] [device]');
      return cmdCommand(rest[0], action, rest[1]);
    }
    case 'click': {
      const { action, rest } = splitAction(args, 0);
      argumentsFor(rest, 0, 'click [action] [device]');
      device = rest[0]; companion = true;
      operation = (atv) => atv.click(action);
      break;
    }
    case 'swipe': {
      argumentsFor(args, 5, 'swipe <x1> <y1> <x2> <y2> <ms> [device]');
      const [x1, y1, x2, y2, ms] = args.slice(0, 5).map((value, i) => {
        const number = numberArgument(value, i < 4 ? 0 : 1, i < 4 ? 1000 : 60000);
        if (!Number.isInteger(number)) throw new Error(`Invalid numeric argument: ${value}`);
        return number;
      });
      device = args[5]; companion = true;
      operation = (atv) => atv.swipe(x1, y1, x2, y2, ms);
      break;
    }
    case 'output': {
      const [action, ...values] = args;
      // Routing resolves only once the TV reports the new group, so no post-send wait is needed.
      acknowledged = true;
      // Rows reuse the printer's `id\tname` format.
      const rows = (atv: AppleTV) => atv.outputDevices.map((d) => ({ id: d.identifier, name: d.name }));
      if (action === 'list') {
        argumentsFor(values, 0, 'output list [device]');
        device = values[0];
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
        operation = async (atv) => { await atv[method](ids); return rows(atv); };
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
    case 'raop-stream':
      if (args.length !== 2 || !isIPv4(args[0]) || !args[1].trim()) throw new Error('Usage: atv raop-stream <ipv4> <file.pcm>');
      return cmdRaopStream(args[0], args[1]);
    case 'stop': case 'power':
      argumentsFor(args, 0, `${cmd} [device]`);
      device = args[0]; companion = acknowledged = cmd === 'power';
      operation = cmd === 'stop' ? (atv) => atv.stop() : (atv) => atv.fetchPowerState();
      break;
    case 'seek': case 'skip-forward': case 'skip-backward': case 'volume': {
      argumentsFor(args, 1, `${cmd} <number> [device]`);
      const value = numberArgument(args[0], 0, cmd === 'volume' ? 100 : Infinity, cmd.startsWith('skip-'));
      device = args[1];
      companion = cmd !== 'seek' && Boolean((await loadCredentials(device)).credentials.companionCredentials);
      acknowledged = companion;
      operation = (atv) => cmd === 'seek' ? atv.setPosition(value) : cmd === 'volume' ? atv.setVolume(value) :
        cmd === 'skip-forward' ? atv.skipForward(value) : atv.skipBackward(value);
      break;
    }
    case 'shuffle': case 'repeat': {
      argumentsFor(args, 1, `${cmd} <mode> [device]`);
      const shuffle: Record<string, ShuffleState> = { off: ShuffleState.Off, albums: ShuffleState.Albums, songs: ShuffleState.Songs };
      const repeat: Record<string, RepeatState> = { off: RepeatState.Off, track: RepeatState.Track, all: RepeatState.All };
      if (!Object.hasOwn(cmd === 'shuffle' ? shuffle : repeat, args[0])) throw new Error(`Invalid ${cmd} mode: ${args[0]}`);
      device = args[1];
      operation = (atv) => cmd === 'shuffle' ? atv.setShuffle(shuffle[args[0]]) : atv.setRepeat(repeat[args[0]]);
      break;
    }
    case 'text': {
      const [action, ...values] = args;
      companion = true; // modern tvOS ignores the MRP TextInputMessage; text uses Companion RTI
      if (action === 'clear') {
        argumentsFor(values, 0, 'text clear [device]');
        device = values[0]; operation = (atv) => atv.clearText();
      } else if (action === 'focus') {
        argumentsFor(values, 0, 'text focus [device]');
        device = values[0]; acknowledged = true;
        operation = (atv) => atv.fetchTextFocusState();
      } else if (action === 'set' || action === 'append') {
        // Empty text is valid; unlike identifiers it must not be trimmed or rejected.
        if (values.length < 1 || values.length > 2 || (values[1] !== undefined && !values[1].trim())) throw new Error(`Usage: atv text ${action} <text> [device]`);
        device = values[1];
        operation = (atv) => action === 'set' ? atv.setText(values[0]) : atv.insertText(values[0]);
      } else throw new Error('Usage: atv text <set|append|clear|focus> ...');
      break;
    }
    case 'app': case 'account': {
      const [action, ...values] = args;
      companion = true;
      if (action === 'list') {
        argumentsFor(values, 0, `${cmd} list [device]`);
        device = values[0]; acknowledged = true;
        operation = (atv) => cmd === 'app' ? atv.appList() : atv.accountList();
      } else if (action === (cmd === 'app' ? 'launch' : 'switch')) {
        argumentsFor(values, 1, `${cmd} ${action} <id> [device]`);
        device = values[1];
        operation = (atv) => cmd === 'app' ? atv.launchApp(values[0]) : atv.switchAccount(values[0]);
      } else throw new Error(`Invalid ${cmd} operation: ${action ?? '(missing)'}`);
      break;
    }
    case 'scan': case 'pair': case 'companion-pair':
      if (args.length) throw new Error(`Usage: atv ${cmd}`);
      return cmd === 'scan' ? cmdScan() : cmd === 'pair' ? cmdPair() : cmdCompanionPair();
    case 'remote': case 'state': case 'queue': case 'messages': case 'keyboard': case 'companion-test':
      argumentsFor(args, 0, `${cmd} [device]`);
      switch (cmd) {
        case 'remote': return cmdRemote(args[0]);
        case 'state': return cmdState(args[0]);
        case 'queue': return cmdQueue(args[0]);
        case 'messages': return cmdMessages(args[0]);
        case 'keyboard': return cmdKeyboard(args[0]);
        case 'companion-test': return cmdCompanionTest(args[0]);
      }
      return;
    case 'artwork':
      if (args.length > 2) throw new Error('Usage: atv artwork [device] [output.jpg]');
      return cmdArtwork(args[0], args[1]);
    default: throw new Error(`Unknown command: ${cmd}. Run "atv --help".`);
  }
  const atv = await (companion ? connectToCompanion(device) : connectToDevice(device));
  try {
    const result = await operation(atv);
    if (Array.isArray(result)) {
      for (const item of result) console.log(`${'bundleId' in item ? item.bundleId : item.id}\t${item.name}`);
    } else if (result !== undefined) console.log(result);
    // Give unacknowledged sends time to reach the TV before close() destroys the socket.
    if (!acknowledged) await delay(postSendMs());
  } finally {
    await atv.close();
  }
}

// Importing the CLI for tests does not execute commands or touch stored credentials.
// realpathSync resolves npm bin symlinks; an unresolvable argv[1] just means "not the script".
let isScript = false;
try { isScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* not the script */ }
if (isScript) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
