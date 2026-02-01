#!/usr/bin/env node
import { scan } from '../discovery.js';
import { AppleTV, Key } from '../appletv.js';
import { Credentials } from '../credentials.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message } from '../message.js';

const CREDS_FILE = join(process.env.HOME ?? '.', '.atv-credentials.json');

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

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

/** Map of CLI command names to Key enum values */
const COMMAND_NAMES = Object.values(Key);
const COMMAND_SET = new Set<string>(COMMAND_NAMES);

async function connectToDevice(deviceId?: string): Promise<AppleTV> {
  if (!existsSync(CREDS_FILE)) {
    throw new Error('No credentials found. Run "atv pair" first.');
  }
  const stored = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  const entries = Object.entries(stored);
  if (entries.length === 0) {
    throw new Error('No paired devices.');
  }

  const [id, credsJson] = deviceId
    ? entries.find(([k]) => k.toLowerCase().includes(deviceId.toLowerCase())) ?? entries[entries.length - 1]
    : entries[entries.length - 1];

  const creds = Credentials.deserialize(credsJson as string);

  console.log('Finding device...');
  const devices = await scan({ timeout: 5000 });
  const idLower = id.toLowerCase();
  const device = devices.find((d) =>
    d.deviceId.toLowerCase() === idLower ||
    d.name.toLowerCase().includes(idLower) ||
    d.deviceId.toLowerCase().includes(idLower),
  );
  if (!device) {
    throw new Error(`Device not found on network (looking for "${id}"). Found: ${devices.map((d) => `${d.name} [${d.deviceId}]`).join(', ')}`);
  }

  console.log(`Connecting to ${device.name} (${device.address}:${device.port})...`);
  const atv = new AppleTV(device);
  await atv.connect(creds);
  return atv;
}

async function cmdCommand(command: string, deviceId?: string) {
  const atv = await connectToDevice(deviceId);

  if (!COMMAND_SET.has(command)) {
    console.log(`Unknown command: ${command}`);
    console.log(`Available: ${COMMAND_NAMES.join(', ')}`);
  } else {
    await atv.sendKeyCommand(command as Key);
    console.log(`Sent: ${command}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await atv.close();
}

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

async function cmdState(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.log('Requesting state...');
    const response = await atv.getState();
    const setState = response['.setStateMessage'] as Record<string, unknown> | undefined;
    if (!setState) {
      console.log('No state info received.');
      await atv.close();
      return;
    }

    // State comes via PlaybackQueueRequest — extract metadata from contentItems
    const queue = setState.playbackQueue as Record<string, unknown> | undefined;
    const items = queue?.contentItems as Record<string, unknown>[] | undefined;
    const playerPath = setState.playerPath as Record<string, unknown> | undefined;
    const client = playerPath?.client as Record<string, unknown> | undefined;
    const appName = client?.bundleIdentifier as string | undefined;

    if (items && items.length > 0) {
      const metadata = items[0].metadata as Record<string, unknown> | undefined;
      if (metadata) {
        const title = metadata.title ?? '';
        const artist = metadata.trackArtistName ?? metadata.albumArtistName ?? '';
        const album = metadata.albumName ?? '';
        const duration = metadata.duration as number ?? 0;
        const elapsed = metadata.elapsedTime as number ?? 0;
        const rate = metadata.playbackRate as number ?? 0;
        const state = rate > 0 ? 'Playing' : 'Paused';

        const parts: string[] = [];
        if (title) parts.push(String(title));
        if (artist) parts.push(`by ${artist}`);
        if (album) parts.push(`on ${album}`);
        parts.push(`[${state}]`);
        if (duration > 0) {
          const pct = ((elapsed / duration) * 100).toFixed(1);
          const eMins = Math.floor(elapsed / 60);
          const eSecs = Math.floor(elapsed % 60);
          const dMins = Math.floor(duration / 60);
          const dSecs = Math.floor(duration % 60);
          parts.push(`${eMins}:${String(eSecs).padStart(2, '0')}/${dMins}:${String(dSecs).padStart(2, '0')} (${pct}%)`);
        }
        if (appName) parts.push(`(${appName})`);
        console.log(parts.join(' '));
      } else {
        console.log('Content item has no metadata.');
      }
    } else {
      console.log('Nothing playing.');
    }
  } catch (e) {
    console.error(`Error: ${e}`);
  }
  await atv.close();
}

async function cmdQueue(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  try {
    console.log('Requesting playback queue...');
    const response = await atv.requestPlaybackQueue({
      location: 0,
      length: 20,
      includeMetadata: true,
    });
    const setState = response['.setStateMessage'] as Record<string, unknown> | undefined;
    const queue = setState?.playbackQueue as Record<string, unknown> | undefined;
    const items = queue?.contentItems as Record<string, unknown>[] | undefined;
    if (items && items.length > 0) {
      items.forEach((item, i) => {
        const metadata = item.metadata as Record<string, unknown> | undefined;
        const title = metadata?.title ?? item.identifier ?? '(unknown)';
        console.log(`  ${i + 1}. ${title}`);
      });
    } else {
      console.log('No items in playback queue.');
    }
  } catch (e) {
    console.error(`Error: ${e}`);
  }
  await atv.close();
}

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
  } catch (e) {
    console.error(`Error: ${e}`);
  }
  await atv.close();
}

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

// Main
const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'scan':
    cmdScan().catch(console.error);
    break;
  case 'pair':
    cmdPair().catch(console.error);
    break;
  case 'command':
  case 'cmd':
    cmdCommand(args[0], args[1]).catch(console.error);
    break;
  case 'remote':
    cmdRemote(args[0]).catch(console.error);
    break;
  case 'state':
    cmdState(args[0]).catch(console.error);
    break;
  case 'queue':
    cmdQueue(args[0]).catch(console.error);
    break;
  case 'artwork':
    cmdArtwork(args[0], args[1]).catch(console.error);
    break;
  case 'messages':
    cmdMessages(args[0]).catch(console.error);
    break;
  default:
    console.log('Usage:');
    console.log('  atv scan                           Scan for Apple TVs');
    console.log('  atv pair                           Pair with an Apple TV');
    console.log('  atv command <cmd> [device]         Send a command');
    console.log('  atv remote [device]                Interactive remote');
    console.log('  atv state [device]                 Show now-playing info');
    console.log('  atv queue [device]                 Show playback queue');
    console.log('  atv artwork [device] [output.jpg]  Save artwork to file');
    console.log('  atv messages [device]              Stream raw MRP messages');
    console.log('');
    console.log('Commands: up, down, left, right, select, menu, home, home_hold,');
    console.log('          top_menu, play, pause, play_pause, next, previous,');
    console.log('          skip_forward, skip_backward, volume_up, volume_down,');
    console.log('          wake, suspend');
}
