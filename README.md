# node-appletv-remote

[![npm](https://img.shields.io/npm/v/node-appletv-remote)](https://www.npmjs.com/package/node-appletv-remote)
[![license](https://img.shields.io/npm/l/node-appletv-remote)](./LICENSE)

Pure Node.js library and CLI for remote controlling Apple TV devices over the local network using AirPlay 2, MRP (Media Remote Protocol), and the Companion Link protocol.

No native dependencies — uses only Node.js built-in crypto and networking APIs alongside a small set of JavaScript libraries.

I wanted to learn the handshake process of the apple TV and implement in typescript so I created this project since the other node implementations are dperecated and no longer work with latest apple tvs.

Inspired by [pyatv](https://pyatv.dev/) and the original [node-appletv](https://github.com/evandcoleman/node-appletv).

## Status

Tested and working against Apple TV 4K — discovery, AirPlay pairing, companion pairing, navigation, media controls, now-playing state, playback queue, artwork, and raw message streaming all confirmed over local network. Artwork availability depends on the app (e.g. YouTube doesn't expose it via MRP).

## CLI Usage

### Scan for devices

```bash
atv scan
```

Lists all Apple TV devices found on the local network (5-second scan).

### Pair with a device (AirPlay)

```bash
atv pair
```

Walks through the AirPlay pairing flow — a PIN will appear on your Apple TV screen. Enter it when prompted. Credentials are saved to `~/.atv-credentials.json`.

### Pair with a device (Companion)

```bash
atv companion-pair
```

Pairs over the Companion Link protocol. A PIN will appear on your Apple TV screen — enter it when prompted. Companion credentials are merged into `~/.atv-credentials.json` alongside any existing AirPlay credentials.

### Send a command

```bash
atv command <command> [deviceId]
```

Sends a single command and disconnects. If `deviceId` is omitted, the most recently paired device is used.

### Interactive remote

```bash
atv remote [deviceId]
```

Opens an interactive prompt where you can type commands continuously. Type `help` to see available commands, `quit` to exit.

### Show now-playing info

```bash
atv state [deviceId]
```

Connects, requests the current playback state, prints track title/artist/app/progress, and disconnects.

Example output:
```
Oh, No! Where is my Mouth? by Pit & Penny Stories [Playing] 0:00/62:19 (0.0%) (com.google.ios.youtube)
```

### Show playback queue

```bash
atv queue [deviceId]
```

Connects, requests the playback queue, prints track titles, and disconnects.

### Save artwork

```bash
atv artwork [deviceId] [output.jpg]
```

Connects, requests artwork for the current track, saves it to a file, and disconnects. Artwork availability depends on the app — some apps (e.g. YouTube) don't expose artwork via MRP.

### Stream messages

```bash
atv messages [deviceId]
```

Connects and streams all raw MRP messages in real time until Ctrl+C.

### Available commands

| Command | Description |
|---------|-------------|
| `up` | D-pad up |
| `down` | D-pad down |
| `left` | D-pad left |
| `right` | D-pad right |
| `select` | Select / OK |
| `menu` | Menu button |
| `home` | Home button |
| `home_hold` | Long-press home |
| `top_menu` | Top menu button |
| `play` | Play |
| `pause` | Pause |
| `play_pause` | Toggle play/pause |
| `next` | Next track |
| `previous` | Previous track |
| `skip_forward` | Skip forward |
| `skip_backward` | Skip backward |
| `volume_up` | Volume up |
| `volume_down` | Volume down |
| `wake` | Wake from sleep |
| `suspend` | Put to sleep |

## Library API

```bash
npm install node-appletv-remote
```

```typescript
import {
  scan, AppleTV, Credentials, Key,
  NowPlayingInfo, PlaybackState, SupportedCommand, Command,
  Message, AirPlayConnection, parseCredentials,
} from 'node-appletv-remote';
```

### Discover devices

```typescript
const devices = await scan({ timeout: 5000, filter: d => d.name.includes('Living Room') });
// [{ name, address, port, deviceId, model }]
```

### Pair with a device (AirPlay)

```typescript
const atv = new AppleTV(devices[0]);
const pairingSession = await atv.startPairing();

// Enter the 4-digit PIN displayed on the Apple TV screen:
const credentials = await pairingSession.finish(pin);
```

### Pair with a device (Companion)

```typescript
const atv = new AppleTV(devices[0]);
const companionSession = await atv.startCompanionPairing();

// Enter the PIN displayed on the Apple TV screen:
const companionCredentials = await companionSession.finish(pin);
```

### Connect and send commands

```typescript
const atv = new AppleTV(device);
await atv.connect(credentials);

// Navigation
await atv.up();
await atv.down();
await atv.left();
await atv.right();
await atv.select();
await atv.menu();
await atv.home();

// Media control
await atv.play();
await atv.pause();
await atv.playPause();
await atv.next();
await atv.previous();
await atv.skipForward();
await atv.skipBackward();
await atv.volumeUp();
await atv.volumeDown();

// Device power
await atv.wake();
await atv.suspend();

// Get current state (title, artist, app, progress)
const state = await atv.getState();

// Playback queue and artwork
const queue = await atv.requestPlaybackQueue();
const artwork = await atv.requestArtwork(400, 400); // null if unavailable

// Type-safe key command
await atv.sendKeyCommand(Key.Play);

atv.close();
```

### Events

```typescript
atv.on('connect', () => { /* connected */ });
atv.on('close', () => { /* disconnected */ });
atv.on('error', (err) => { /* handle error */ });

// Now-playing updates (pushed by Apple TV)
atv.on('nowPlaying', (info: NowPlayingInfo) => {
  console.log(info.toString());
});

// Supported commands updates
atv.on('supportedCommands', (commands: SupportedCommand[]) => {
  commands.forEach(cmd => console.log(cmd.toString()));
});

// Playback queue updates
atv.on('playbackQueue', (queue) => {
  console.log(queue);
});

// All raw MRP messages
atv.on('message', (msg: Message) => {
  console.log(msg.toString());
});
```

## Architecture

| Layer | Description |
|-------|-------------|
| **AppleTV API** | `scan()` · `connect()` · navigation · media · `getState()` · `requestPlaybackQueue()` · `requestArtwork()` |
| **AirPlayConnection** | RTSP session · Event channel · Data channel · Heartbeat |
| **HAP Auth** | SRP pair-setup · X25519 pair-verify · Ed25519 signatures · Companion pair-setup |
| **MRP Protocol** | Protobuf messages · HID events · Media commands |
| **HAP Encryption** | ChaCha20-Poly1305 · HKDF-SHA512 derived keys |
| **DataStream Framing** | 32-byte headers · bplist payloads |
| **Transport** | TCP (port 7000) |

### Connection flow

1. **Discovery** — mDNS scan for `_airplay._tcp` and `_companion-link._tcp` services
2. **Pair-Setup** (first time) — SRP exchange using a PIN displayed on the TV
3. **Pair-Verify** — X25519 key exchange + Ed25519 signature proof using stored credentials
4. **RTSP Session** — Encrypted AirPlay session setup
5. **Event Channel** — Separate socket for inbound notifications
6. **Data Channel** — MRP tunnel carrying protobuf-encoded remote control messages
7. **Heartbeat** — `/feedback` POST every 2 seconds to keep the connection alive

**Note:** MRP CryptoPairing is not performed over AirPlay transport — the data channel is already encrypted at the HAP layer. This matches [pyatv's behavior](https://pyatv.dev/documentation/protocols/).

### Key directories

```
src/
├── index.ts             # Public API exports
├── appletv.ts           # High-level AppleTV class with Key enum
├── credentials.ts       # Credential serialization + parseCredentials()
├── discovery.ts         # Bonjour/mDNS device scanning
├── connection.ts        # AirPlay connection + protocol state machine
├── now-playing-info.ts  # NowPlayingInfo class + PlaybackState enum
├── supported-command.ts # SupportedCommand class + Command enum
├── message.ts           # Message wrapper for decoded MRP protobuf
├── auth/                # HAP pairing (SRP setup, X25519 verify)
├── companion/           # Companion Link protocol (OPACK, framing, pair-setup)
├── mrp/                 # MRP protobuf message builders
├── util/                # Crypto, TLV, HTTP, framing helpers
├── cli/                 # CLI entry point (atv command)
└── proto/               # 66 protobuf schema files
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests (68 tests)
npm test

# Run tests in watch mode
npm run test:watch
```

Requires Node.js 18+ (ES2022 target, ESM modules).