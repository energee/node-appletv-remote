# node-atv

Pure Node.js library and CLI for remote controlling Apple TV devices over the local network using AirPlay and MRP (Media Remote Protocol).

No native dependencies — uses only Node.js built-in crypto and networking APIs alongside a small set of JavaScript libraries.

## Features

- Discover Apple TV devices on the local network via mDNS/Bonjour
- Secure pairing using HAP (HomeKit Accessory Protocol) with SRP
- Encrypted communication over AirPlay with ChaCha20-Poly1305
- Full remote control: navigation, media playback, volume
- Programmatic API and interactive CLI

## Install

```bash
npm install node-atv
```

To use the CLI globally:

```bash
npm install -g node-atv
```

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
| `play_pause` | Toggle play/pause |
| `volume_up` | Volume up |
| `volume_down` | Volume down |

## Library API

```typescript
import { scan, AppleTV, Credentials } from 'node-atv';
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
const credentials = await pairingSession.finishPairing(pin);
```

### Connect and send commands

```typescript
const atv = new AppleTV(device);
await atv.connect(credentials);

await atv.up();
await atv.select();
await atv.playPause();
await atv.home();

atv.close();
```

### Events

```typescript
atv.on('connect', () => { /* connected */ });
atv.on('close', () => { /* disconnected */ });
atv.on('error', (err) => { /* handle error */ });
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   AppleTV API                     │
│  scan() · connect() · up/down/select/play/...    │
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

### Key directories

```
src/
├── index.ts           # Public API exports
├── appletv.ts         # High-level AppleTV class
├── credentials.ts     # Credential serialization
├── discovery.ts       # Bonjour/mDNS device scanning
├── connection.ts      # AirPlay connection + protocol state machine
├── auth/              # HAP pairing (SRP setup, X25519 verify)
├── mrp/               # MRP protobuf message builders
├── util/              # Crypto, TLV, HTTP, framing helpers
└── proto/             # 66 protobuf schema files
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

Requires Node.js with ES2022 support. The project uses ESM modules (`"type": "module"`).

## License

MIT
