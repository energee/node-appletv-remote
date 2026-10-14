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
  ShuffleState, RepeatState, PowerState,
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

`startPairing()` returns a `PairSetup`, which is also exported from the package entry.

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
await atv.skipForward();      // app's default interval
await atv.skipBackward(30);   // or an explicit number of seconds
await atv.setPosition(120);   // seek to 2:00
await atv.setShuffle(ShuffleState.Songs);
await atv.setRepeat(RepeatState.All);
await atv.volumeUp();
await atv.volumeDown();
await atv.setVolume(40);      // absolute, 0..100; atv.volume holds the last reported level

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

### Apps, accounts, power state and extra buttons (Companion)

These go over the Companion protocol, so call `connectCompanion()` first:

```typescript
await atv.connectCompanion(credentials.companionCredentials);

const apps = await atv.appList();             // [{ name: 'Netflix', bundleId: 'com.netflix.Netflix' }, ...]
await atv.launchApp('com.netflix.Netflix');   // by bundle ID
await atv.launchApp('https://www.youtube.com/watch?v=dQw4w9WgXcQ'); // or a URL / URL scheme

const accounts = await atv.accountList();     // [{ name: 'Alice', id: '...' }, ...]
await atv.switchAccount(accounts[0].id);

await atv.fetchPowerState();                  // PowerState.On | Off | Unknown, also cached in atv.powerState
atv.subscribePowerState();                    // then 'powerState' fires on changes

await atv.channelUp();
await atv.channelDown();
await atv.guide();
await atv.pageUp();
await atv.pageDown();
await atv.screensaver();
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

// Absolute volume (0..100) when it changes
atv.on('volume', (level: number) => { /* ... */ });

// Power state changes, after subscribePowerState()
atv.on('powerState', (state: PowerState) => { /* ... */ });

// All raw MRP messages
atv.on('message', (msg: Message) => {
  console.log(msg.toString());
});
```

## Architecture

| Layer | Description |
|-------|-------------|
| **AppleTV API** | `scan()` · `connect()` · navigation · media · seek/shuffle/repeat · `setVolume()` · `getState()` · `requestPlaybackQueue()` · `requestArtwork()` · apps · accounts · power state |
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
├── mrp/schema.ts        # MRP schema generated from proto/ (npm run gen:proto)
└── proto/               # 66 protobuf schema files (build input only)
```

## Development

### OPACK values

For low-level Companion requests, wrap integral values in `new OpackFloat(value)`
when the protocol requires a floating-point value, such as skip seconds or the
volume endpoints 0 and 1. Ordinary nonnegative safe integers keep their compact
integer encoding. Negative numbers use float64; unsigned 64-bit identifiers
must use `bigint` to preserve precision. The decoder accepts compact and extended
object references in device replies.

`sendCompanionRequest` and `sendCompanionMessage` wrap bare content in the Companion
envelope `{ _i, _t, _c, _x }`, with `_t` 2 for a request and 1 for a message:

```typescript
const info = await atv.sendCompanionRequest('_systemInfo', new Map([['_bf', 0]]));
```

Content that already has `_t`, `_c` or `_x` is sent as a prebuilt envelope, with only
`_i` and `_x` filled in.

Encrypted Companion frame lengths include their authentication tag. Independent
pyatv fixtures verify both encryption and streaming reception of these frames.

Companion request IDs stay in 1..127. A timed-out request keeps its ID reserved for
30 seconds, or until its late reply arrives, so the reply cannot resolve a newer request.
`sendCompanionMessage` never runs out of IDs, but throws if you pass an `_x` that a
pending request is using. Empty frames are passed through unencrypted, as on the wire.

The compatibility tests include independent fixtures from pyatv 0.18.0 and the
[published OPACK protocol examples](https://pyatv.dev/documentation/protocols/#opack).

```bash
# Install dependencies
npm install

# Build (regenerates src/mrp/schema.ts from src/proto)
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

The MRP schema is compiled into `src/mrp/schema.ts`, so no `.proto` files are read at
run time and the package can be bundled (e.g. `bun build`). After editing a `.proto` file
or adding one to `PROTO_FILES` in `scripts/gen-proto.mjs`, run `npm run gen:proto` and
commit the regenerated schema.

Requires Node.js 18+ (ES2022 target, ESM modules).
