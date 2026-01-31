#!/usr/bin/env node
import { scan } from '../discovery.js';
import { AppleTV } from '../appletv.js';
import { Credentials } from '../credentials.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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

function commandMap(atv: AppleTV): Record<string, () => Promise<void>> {
  return {
    up: () => atv.up(),
    down: () => atv.down(),
    left: () => atv.left(),
    right: () => atv.right(),
    select: () => atv.select(),
    menu: () => atv.menu(),
    home: () => atv.home(),
    play: () => atv.playPause(),
    pause: () => atv.playPause(),
    play_pause: () => atv.playPause(),
    volume_up: () => atv.volumeUp(),
    volume_down: () => atv.volumeDown(),
  };
}

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
  const cmds = commandMap(atv);

  const fn = cmds[command];
  if (!fn) {
    console.log(`Unknown command: ${command}`);
    console.log(`Available: ${Object.keys(cmds).join(', ')}`);
  } else {
    await fn();
    console.log(`Sent: ${command}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await atv.close();
}

async function cmdRemote(deviceId?: string) {
  const atv = await connectToDevice(deviceId);
  const cmds = commandMap(atv);
  const cmdNames = Object.keys(cmds);

  console.log(`Connected. Type commands to send (${cmdNames.join(', ')})`);
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
      console.log(`Commands: ${cmdNames.join(', ')}`);
      rl.prompt();
      return;
    }
    const fn = cmds[input];
    if (!fn) {
      console.log(`Unknown: ${input}. Type "help" for commands.`);
    } else {
      try {
        await fn();
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
  default:
    console.log('Usage:');
    console.log('  atv scan                    Scan for Apple TVs');
    console.log('  atv pair                    Pair with an Apple TV');
    console.log('  atv command <cmd> [device]  Send a command');
    console.log('  atv remote [device]         Interactive remote');
    console.log('');
    console.log('Commands: up, down, left, right, select, menu, home,');
    console.log('          play, pause, play_pause, volume_up, volume_down');
}
