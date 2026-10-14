# node-appletv-remote

[![npm](https://img.shields.io/npm/v/node-appletv-remote)](https://www.npmjs.com/package/node-appletv-remote)
[![license](https://img.shields.io/npm/l/node-appletv-remote)](./LICENSE)

Control an Apple TV from Node.js, as a library or a CLI. It speaks AirPlay 2, MRP (Media Remote Protocol) and Companion Link over your local network, with no native dependencies.

I built this to learn how the Apple TV handshake works, and because the older Node libraries no longer work with current Apple TVs. Inspired by [pyatv](https://pyatv.dev/) and the original [node-appletv](https://github.com/evandcoleman/node-appletv).

**Status:** tested on an Apple TV 4K. Discovery, pairing, navigation, media controls, now-playing, playback queue and artwork all work. Some apps (YouTube, for one) don't expose artwork.

## CLI

```bash
atv scan                          # find Apple TVs on the network
atv pair                          # AirPlay pairing (enter the PIN shown on the TV)
atv companion-pair                # Companion pairing, needed for apps/accounts/power

atv command <command> [deviceId]  # send one command, e.g. `atv command play`
atv remote [deviceId]             # interactive remote; type `help` for commands
atv state [deviceId]              # what's playing
atv queue [deviceId]              # playback queue
atv artwork [deviceId] [out.jpg]  # save current artwork
atv messages [deviceId]           # stream raw MRP messages until Ctrl+C
```

Credentials are saved to `~/.atv-credentials.json`. Leave out `deviceId` to use the most recently paired device. Each device's last working address is cached in `~/.atv-devices.json`, so commands skip the network scan. If the TV has moved, the CLI rescans automatically.

Two timing knobs exist for older or slower Apple TVs. Both default to `0`:

- `ATV_SETTLE_MS`: pause after the MRP handshake before sending anything (previously a fixed 500 ms). Library equivalent: `atv.connect(credentials, { settleMs: 500 })`.
- `ATV_POST_SEND_MS`: pause after `atv command` sends a key, before disconnecting (previously a fixed 1000 ms).

```
$ atv state
Oh, No! Where is my Mouth? by Pit & Penny Stories [Playing] 0:00/62:19 (0.0%) (com.google.ios.youtube)
```

**Commands:** `up` `down` `left` `right` `select` `menu` `home` `home_hold` `top_menu` · `play` `pause` `play_pause` `next` `previous` `skip_forward` `skip_backward` · `volume_up` `volume_down` · `wake` `suspend`

## Library

```bash
npm install node-appletv-remote
```

Requires Node.js 18+ (ESM).

### Find and pair

```typescript
import { scan, AppleTV } from 'node-appletv-remote';

const [device] = await scan({ timeout: 5000 });
// or stop as soon as the TV you want shows up:
// await scan({ until: (d) => d.name === 'Living Room' });
const atv = new AppleTV(device);

// AirPlay pairing: a PIN appears on the TV
const pairing = await atv.startPairing();
const credentials = await pairing.finish(pin);

// Companion pairing (optional, for apps, accounts and power state)
const companionPairing = await atv.startCompanionPairing();
const companionCredentials = await companionPairing.finish(pin);
```

### Remote control (AirPlay/MRP)

```typescript
await atv.connect(credentials);

await atv.up();            // also down, left, right, select, menu, home, topMenu
await atv.playPause();     // also play, pause, stop, next, previous
await atv.skipForward();   // app's default interval, or pass seconds: skipBackward(30)
await atv.setPosition(120);
await atv.setShuffle(ShuffleState.Songs);
await atv.setRepeat(RepeatState.All);
await atv.setVolume(40);   // 0–100; also volumeUp, volumeDown
await atv.wake();          // also suspend

const state = await atv.getState();
const art = await atv.requestArtwork(400, 400); // null if the app has none

await atv.close();
```

### Apps, accounts and power (Companion)

```typescript
await atv.connectCompanion(companionCredentials);

const apps = await atv.appList();            // [{ name, bundleId }]
await atv.launchApp('com.netflix.Netflix');  // or a URL: 'https://youtube.com/watch?v=...'

const accounts = await atv.accountList();    // [{ name, id }]
await atv.switchAccount(accounts[0].id);

await atv.fetchPowerState();                 // PowerState.On / Off / Unknown
atv.subscribePowerState();                   // then listen for 'powerState'

await atv.guide();  // also channelUp, channelDown, pageUp, pageDown, screensaver
```

### Events

```typescript
atv.on('nowPlaying', (info) => console.log(info.toString()));  // NowPlayingInfo
atv.on('volume', (level) => {});           // 0–100
atv.on('powerState', (state) => {});       // after subscribePowerState()
atv.on('supportedCommands', (cmds) => {}); // SupportedCommand[]
atv.on('playbackQueue', (queue) => {});
atv.on('keyboard', (kb) => {});            // text field focused/unfocused
atv.on('message', (msg) => {});            // every raw MRP message
atv.on('close', () => {});
atv.on('error', (err) => {});
```

## How it works

1. **Discovery:** mDNS for `_airplay._tcp` and `_companion-link._tcp`.
2. **Pair-setup** (first time only): SRP with the PIN shown on the TV.
3. **Pair-verify:** X25519 + Ed25519 using the stored credentials.
4. **AirPlay session:** encrypted RTSP, plus an event channel and a data channel.
5. **MRP** runs as protobuf over the data channel. A `/feedback` heartbeat every 2s keeps it alive.

MRP's own CryptoPairing is skipped because the data channel is already HAP-encrypted, [same as pyatv](https://pyatv.dev/documentation/protocols/).

```
src/
├── appletv.ts      # AppleTV class (start here)
├── connection.ts   # AirPlay session + MRP data channel
├── discovery.ts    # mDNS scanning
├── auth/           # HAP pair-setup / pair-verify
├── companion/      # Companion Link: OPACK, framing, pairing
├── mrp/            # MRP message builders + generated schema.ts
├── proto/          # .proto sources (build input only)
├── util/           # crypto, TLV, HTTP helpers
└── cli/            # the `atv` command
```

## Advanced: raw Companion messages

For anything not wrapped yet, send Companion messages yourself:

```typescript
const info = await atv.sendCompanionRequest('_systemInfo', new Map([['_bf', 0]]));
atv.sendCompanionMessage('_interest', new Map([['_regEvents', ['SystemStatus']]]));
```

- Plain content is wrapped as `{ _i, _t, _c, _x }`. `_t` is 2 for a request and 1 for a message. If you pass a prebuilt envelope (with `_t`, `_c` or `_x`), only `_i` and `_x` get filled in.
- Wrap whole numbers in `new OpackFloat(n)` when the protocol expects a float, such as skip seconds or volume 0/1. Use `bigint` for unsigned 64-bit IDs.
- Request IDs stay in 1..127, since Apple TVs read larger single-byte IDs as negative. A timed-out ID stays reserved for 30s so a late reply can't resolve the wrong request.

The OPACK and framing tests use fixtures from pyatv 0.18.0 and the [published OPACK examples](https://pyatv.dev/documentation/protocols/#opack).

## Development

```bash
npm install
npm run build        # also regenerates src/mrp/schema.ts
npm test             # or npm run test:watch
```

The MRP schema is compiled into `src/mrp/schema.ts`, so no `.proto` files are read at run time and the package bundles cleanly. After editing a `.proto` (or adding one to `PROTO_FILES` in `scripts/gen-proto.mjs`), run `npm run gen:proto` and commit the result.
