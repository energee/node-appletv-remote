#!/usr/bin/env node
/**
 * `atv` command-line tool: scan, pair, control playback/text and Companion, and inspect now-playing,
 * keyboard, and Companion events. A thin consumer of the public AppleTV API;
 * credentials are stored as JSON in ~/.atv-credentials.json keyed by device ID.
 */
import { scan, type DiscoveredDeviceInfo } from '../discovery.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AppleTV, Key, ShuffleState, RepeatState, contentItems } from '../appletv.js';
import { PlaybackState } from '../now-playing-info.js';
import { MessageType } from '../mrp/messages.js';
import { Credentials } from '../credentials.js';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCachedDevice } from './device-cache.js';
import { createInterface } from 'node:readline';
import type { Message } from '../message.js';
import type { KeyboardInfo, TextInputEvent, CompanionEvent, App, UserAccount, PowerState } from '../appletv.js';

/** Where paired credentials are stored (falls back to the current directory if HOME is unset). */
const CREDS_FILE = join(process.env.HOME ?? '.', '.atv-credentials.json');
/** Last-known address of each paired device, so commands can skip the mDNS scan. */
const DEVICES_FILE = join(process.env.HOME ?? '.', '.atv-devices.json');

/** Non-negative ms from an env var, or `fallback` when unset/invalid; `0` disables the wait. */
function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(value) && value >= 0 ? value : fallback;
}
// HID keys get no device acknowledgment, so the CLI waits before trusting a send (old fixed values).
const settleMs = (): number => envMs('ATV_SETTLE_MS', 500);
const postSendMs = (): number => envMs('ATV_POST_SEND_MS', 1000);

/** Ask one question on stdin and resolve with the raw answer. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** `atv scan`: list Apple TVs found via mDNS within 5 s. */
async function cmdScan() {
  console.log('Scanning for Apple TVs...');
  const devices = await scan({ timeout: 5000 });
  if (devices.length === 0) {
    console.log('No Apple TVs found.');
    return;
  }
  devices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name} (${d.address}:${d.port}) [${d.model}]`);
  });
}

/** `atv pair`: pick a device, run AirPlay pair-setup with the on-screen PIN, and save the credentials. */
async function cmdPair() {
  console.log('Scanning for Apple TVs...');
  const devices = await scan({ timeout: 5000 });
  if (devices.length === 0) {
    console.log('No Apple TVs found.');
    return;
  }

  devices.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d}`);
  });
  const choice = await prompt('Select device number: ');
  const device = devices[parseInt(choice) - 1];
  if (!device) {
    console.log('Invalid selection.');
    return;
  }

  const atv = new AppleTV(device);
  console.log(`Pairing with ${atv.name}...`);
  const pairSetup = await atv.startPairing();

  const pin = await prompt('Enter PIN shown on Apple TV: ');
  const hapCreds = await pairSetup.finish(pin);
  const creds = new Credentials(hapCreds);

  // Save credentials
  let stored: Record<string, string> = {};
  if (existsSync(CREDS_FILE)) {
    stored = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  }
  stored[device.deviceId] = creds.serialize();
  writeFileSync(CREDS_FILE, JSON.stringify(stored, null, 2));
  console.log(`Paired! Credentials saved to ${CREDS_FILE}`);
}

/** Every Key value; these strings are the accepted CLI command names. */
const COMMAND_NAMES = Object.values(Key);
/** Fast membership check for COMMAND_NAMES. */
const COMMAND_SET = new Set<string>(COMMAND_NAMES);

/**
 * Load stored credentials for the first device ID containing `deviceId`
 * (case-insensitive), or the most recently added device only if no selector is given.
 * @throws if credentials are missing/empty or an explicit selector is blank or unmatched.
 */
function loadCredentials(deviceId?: string): { id: string; credentials: Credentials } {
  if (deviceId !== undefined && !deviceId.trim()) throw new Error('Device selector must be nonblank');
  if (!existsSync(CREDS_FILE)) {
    throw new Error('No credentials found. Run "atv pair" first.');
  }
  const stored = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  const entries = Object.entries(stored);
  if (entries.length === 0) {
    throw new Error('No paired devices.');
  }

  const entry = deviceId === undefined ? entries[entries.length - 1]
    : entries.find(([k]) => k.toLowerCase().includes(deviceId.toLowerCase()));
  if (!entry) throw new Error(`No paired device matches "${deviceId}"`);
  const [id, credsJson] = entry;

  return { id, credentials: Credentials.deserialize(credsJson as string) };
}

/**
 * Scan (stopping early once found) and return the device whose ID equals or contains `id`, or whose name contains it (case-insensitive).
 * @throws if nothing matches; the message lists the devices that were found.
 */
async function findDevice(id: string, needCompanion: boolean): Promise<DiscoveredDeviceInfo> {
  console.error('Finding device...');
  const idLower = id.toLowerCase();
  const matches = (d: DiscoveredDeviceInfo) =>
    d.deviceId.toLowerCase() === idLower ||
    d.identifiers?.some(alias => alias.toLowerCase() === idLower) ||
    d.name.toLowerCase().includes(idLower) ||
    d.deviceId.toLowerCase().includes(idLower);
  // Stop as soon as the device (and, if needed, its Companion port) has arrived.
  const devices = await scan({ timeout: 5000, until: (d) => matches(d) && (needCompanion ? !!d.companionPort : !!d.port || !!d.mrpPort && d.mrpEnabled !== false) });
  const device = devices.find(matches);
  if (!device) {
    throw new Error(`Device not found on network (looking for "${id}"). Found: ${devices.map((d) => `${d.name} [${d.deviceId}]`).join(', ')}`);
  }
  return device;
}

/** Run `connect` against the device's cached address, rescanning once if that fails. */
function connectCached<T>(
  id: string,
  needCompanion: boolean,
  connect: (device: DiscoveredDeviceInfo) => Promise<T>,
): Promise<T> {
  return withCachedDevice(DEVICES_FILE, id, () => findDevice(id, needCompanion), connect);
}

/** Load credentials, locate the device (cache first, then mDNS), and open an AirPlay/MRP connection. */
async function connectToDevice(deviceId?: string): Promise<AppleTV> {
  const { id, credentials } = loadCredentials(deviceId);
  return connectCached(id, false, async (device) => {
    console.error(`Connecting to ${device.name} (${device.address}:${device.port})...`);
    const atv = new AppleTV(device);
    atv.on('error', (err: Error) => console.error(`AirPlay error: ${err.message}`));
    try {
      await atv.connect(credentials, { settleMs: settleMs() });
    } catch (e) {
      await atv.close();
      throw e;
    }
    return atv;
  });
}

/** Load Companion credentials and connect only Companion, using the existing address cache. */
async function connectToCompanion(deviceId?: string): Promise<AppleTV> {
  const { id, credentials } = loadCredentials(deviceId);
  if (!credentials.companionCredentials) {
    throw new Error('No companion credentials. Run "atv companion-pair" first.');
  }
  return connectCached(id, true, async (device) => {
    if (!device.companionPort) throw new Error('Device has no companion-link port');
    const atv = new AppleTV(device);
    console.error(`Connecting companion to ${device.name} (${device.address}:${device.companionPort})...`);
    try {
      await atv.connectCompanion(credentials.companionCredentials!);
      return atv;
    } catch (error) {
      await atv.close();
      throw error;
    }
  });
}

/** Companion-only buttons exposed by `command`; no MRP connection is needed. */
const COMPANION_BUTTONS = {
  channel_up: 'channelUp', channel_down: 'channelDown', screensaver: 'screensaver',
  guide: 'guide', page_up: 'pageUp', page_down: 'pageDown',
} as const;

/** Send a validated key or Companion button, then close even if sending fails. */
async function cmdCommand(command: string, deviceId?: string) {
  const button = Object.hasOwn(COMPANION_BUTTONS, command)
    ? COMPANION_BUTTONS[command as keyof typeof COMPANION_BUTTONS] : undefined;
  if (!button && !COMMAND_SET.has(command)) throw new Error(`Unknown command: ${command}. Run "atv --help".`);
  const atv = await (button ? connectToCompanion(deviceId) : connectToDevice(deviceId));
  try {
    if (button) await atv[button]();
    else await atv.sendKeyCommand(command as Key);
    console.log(`Sent: ${command}`);
    await delay(postSendMs());
  } finally {
    await atv.close();
  }
}

/** `atv remote [device]`: interactive prompt that sends each typed key name. */
async function cmdRemote(deviceId?: string) {
  const atv = await connectToDevice(deviceId);

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
async function cmdState(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.log('Requesting state...');
    const info = await atv.getNowPlaying();
    console.log(info.hasPlayback ? info.toString() : `Nothing playing. [${info.playbackState === PlaybackState.Stopped ? 'Stopped' : 'Absent'}]`);
  } finally {
    await atv.close();
  }
}

/** `atv queue [device]`: print up to 20 items from the playback queue. */
async function cmdQueue(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.log('Requesting playback queue...');
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
    console.log('Requesting artwork...');
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

/** `atv companion-pair`: Companion pair-setup; merges the result into the device's existing AirPlay credentials, or stores it standalone. */
async function cmdCompanionPair() {
  console.log('Scanning for Apple TVs...');
  const devices = await scan({ timeout: 5000 });
  const withCompanion = devices.filter((d) => d.companionPort);
  if (withCompanion.length === 0) {
    console.log('No Apple TVs with companion-link found.');
    return;
  }

  withCompanion.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d} [companion:${d.companionPort}]`);
  });
  const choice = await prompt('Select device number: ');
  const device = withCompanion[parseInt(choice) - 1];
  if (!device) {
    console.log('Invalid selection.');
    return;
  }

  const atv = new AppleTV(device);
  console.log(`Companion pairing with ${atv.name} on port ${device.companionPort}...`);
  const pairSetup = await atv.startCompanionPairing();

  const pin = await prompt('Enter PIN shown on Apple TV: ');
  const companionCreds = await pairSetup.finish(pin);

  // Load existing credentials and add companion creds
  let stored: Record<string, string> = {};
  if (existsSync(CREDS_FILE)) {
    stored = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  }

  // Update existing credentials with companion data
  if (stored[device.deviceId]) {
    const existing = Credentials.deserialize(stored[device.deviceId]);
    existing.companionCredentials = companionCreds;
    stored[device.deviceId] = existing.serialize();
  } else {
    console.log('Warning: No AirPlay credentials found. Pair with AirPlay first (atv pair).');
    console.log('Saving companion credentials standalone.');
    const creds = new Credentials(companionCreds, companionCreds);
    stored[device.deviceId] = creds.serialize();
  }

  writeFileSync(CREDS_FILE, JSON.stringify(stored, null, 2));
  console.log(`Companion paired! Credentials saved to ${CREDS_FILE}`);
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

/** Print the CLI syntax; no discovery or credential loading occurs. */
function help(): void {
  console.log(`Usage:
  atv scan | pair | companion-pair
  atv command <key> [device]           Send an MRP key or Companion button (alias: cmd)
  atv stop [device]
  atv seek <seconds> [device]          Absolute position, >= 0
  atv skip-forward <seconds> [device]  Positive interval
  atv skip-backward <seconds> [device] Positive interval
  atv shuffle <off|albums|songs> [device]
  atv repeat <off|track|all> [device]
  atv volume <0..100> [device]
  atv text <set|append> <text> [device] Quote text, including "" for empty text
  atv text clear [device]
  atv app list [device]
  atv app launch <bundle-id-or-url> [device]
  atv account list [device]
  atv account switch <account-id> [device]
  atv power [device]                   Print on, off, or unknown
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
  let device: string | undefined;
  let operation: (atv: AppleTV) => Promise<void | PowerState | App[] | UserAccount[]>;
  switch (cmd) {
    case 'command': case 'cmd':
      argumentsFor(args, 1, 'command <key> [device]');
      return cmdCommand(args[0], args[1]);
    case 'stop': case 'power':
      argumentsFor(args, 0, `${cmd} [device]`);
      device = args[0]; companion = cmd === 'power';
      operation = cmd === 'stop' ? (atv) => atv.stop() : (atv) => atv.fetchPowerState();
      break;
    case 'seek': case 'skip-forward': case 'skip-backward': case 'volume': {
      argumentsFor(args, 1, `${cmd} <number> [device]`);
      const value = numberArgument(args[0], 0, cmd === 'volume' ? 100 : Infinity, cmd.startsWith('skip-'));
      device = args[1];
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
      if (action === 'clear') {
        argumentsFor(values, 0, 'text clear [device]');
        device = values[0]; operation = (atv) => atv.clearText();
      } else if (action === 'set' || action === 'append') {
        // Empty text is valid; unlike identifiers it must not be trimmed or rejected.
        if (values.length < 1 || values.length > 2 || (values[1] !== undefined && !values[1].trim())) throw new Error(`Usage: atv text ${action} <text> [device]`);
        device = values[1];
        operation = (atv) => action === 'set' ? atv.setText(values[0]) : atv.insertText(values[0]);
      } else throw new Error('Usage: atv text <set|append|clear> ...');
      break;
    }
    case 'app': case 'account': {
      const [action, ...values] = args;
      companion = true;
      if (action === 'list') {
        argumentsFor(values, 0, `${cmd} list [device]`);
        device = values[0];
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
    await delay(postSendMs());
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
