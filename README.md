# node-appletv-remote

Pure Node.js library and CLI for remote controlling Apple TV devices over the local network using AirPlay 2 and MRP (Media Remote Protocol).

No native dependencies — uses only Node.js built-in crypto and networking APIs alongside a small set of JavaScript libraries.

Inspired by [pyatv](https://pyatv.dev/) and the original [node-appletv](https://github.com/evandcoleman/node-appletv).

## Confirmed Working

Tested against an Apple TV 4K on the local network (YouTube playback):

| Feature | Status |
|---------|--------|
| Discovery (mDNS scan) | Confirmed |
| Pairing (SRP + PIN) | Confirmed |
| Connection (AirPlay 2 + MRP tunnel) | Confirmed |
| Navigation (up/down/left/right/select/menu/home) | Confirmed |
| `play` / `pause` / `play_pause` | Confirmed |
| `next` / `previous` / `skip_forward` / `skip_backward` | Confirmed |
| `volume_up` / `volume_down` | Confirmed |
| `atv state` — show now-playing info (title, artist, app, progress) | Confirmed |
| `atv queue` — show playback queue track titles | Confirmed |
| `atv artwork` — save current track artwork to file | Works (depends on app — YouTube returns no artwork) |
| `atv messages` — stream raw MRP messages | Confirmed |
| `wake` / `suspend` | Sends command (not verified on sleeping device) |

## CLI Usage

### Scan for devices

```bash
atv scan
```

Lists all Apple TV devices found on the local network (5-second scan).

### Pair with a device

```bash
atv pair
```

Walks through the pairing flow — a PIN will appear on your Apple TV screen. Enter it when prompted. Credentials are saved to `~/.atv-credentials.json`.

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

```typescript
import {
  scan, AppleTV, Credentials, Key,
  NowPlayingInfo, SupportedCommand, Message,
  AirPlayConnection, parseCredentials,
} from 'node-appletv-remote';
```

### Discover devices

```typescript
const devices = await scan({ timeout: 5000 });
// [{ name, address, port, deviceId, model }]
```

### Pair with a device

```typescript
const atv = new AppleTV(devices[0]);
const pairingSession = await atv.startPairing();

// Display the PIN shown on the Apple TV, then:
const credentials = await pairingSession.finish(pin);
```

### Connect and send commands

```typescript
const atv = new AppleTV(device);
await atv.connect(credentials);

// Navigation
await atv.up();
await atv.select();
await atv.home();

// Media control
await atv.play();
await atv.pause();
await atv.next();
await atv.previous();
await atv.playPause();

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

```
┌──────────────────────────────────────────────────┐
│                   AppleTV API                     │
│  scan() · connect() · up/down/select/play/...    │
│  play() · pause() · next() · wake() · suspend()  │
│  getState() · requestPlaybackQueue()              │
├──────────────────────────────────────────────────┤
│              AirPlayConnection                    │
│  RTSP session · Event channel · Data channel     │
├──────────────────────────────────────────────────┤
│       HAP Auth          │      MRP Protocol      │
│  SRP pair-setup         │  Protobuf messages     │
│  X25519 pair-verify     │  HID events            │
│  Ed25519 signatures     │  Media commands        │
├─────────────────────────┼────────────────────────┤
│       HAP Encryption    │    DataStream Framing  │
│  ChaCha20-Poly1305      │  32-byte headers       │
│  HKDF-SHA512 keys       │  bplist payloads       │
├──────────────────────────────────────────────────┤
│                  TCP (port 7000)                  │
└──────────────────────────────────────────────────┘
```

### Connection flow

1. **Discovery** — mDNS scan for `_airplay._tcp` services
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

Requires Node.js with ES2022 support. The project uses ESM modules (`"type": "module"`).

## License

MIT
