# node-appletv-remote

[![CI](https://github.com/energee/node-appletv-remote/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/energee/node-appletv-remote/actions/workflows/ci.yml)
[![npm](https://badgen.net/npm/v/node-appletv-remote)](https://www.npmjs.com/package/node-appletv-remote)
[![downloads](https://badgen.net/npm/dm/node-appletv-remote)](https://www.npmjs.com/package/node-appletv-remote)
[![node](https://badgen.net/npm/node/node-appletv-remote)](./package.json)
[![license](https://badgen.net/npm/license/node-appletv-remote)](./LICENSE)

Control an Apple TV from Node.js, as a library or a CLI. It speaks AirPlay 2, MRP (Media Remote Protocol) and Companion Link over your local network, with no native dependencies.

I built this to learn how the Apple TV handshake works, and because the older Node libraries no longer work with current Apple TVs. Inspired by the original [node-appletv](https://github.com/evandcoleman/node-appletv).

## Install

```bash
npm install node-appletv-remote      # library
npm install -g node-appletv-remote   # `atv` CLI
```

Requires Node.js 20.19+ (ESM).

## Quick start

```typescript
import { scan, AppleTV } from 'node-appletv-remote';

const [device] = await scan({ until: d => d.name === 'Living Room' });
const atv = new AppleTV(device);

// First time only: a PIN appears on the TV. Store the credentials yourself.
const pairing = await atv.startPairing();
const credentials = await pairing.finish(pin);

await atv.connect(credentials);
await atv.playPause();                     // also up, down, select, menu, setVolume, ...
console.log((await atv.getNowPlaying()).toString());
atv.on('nowPlaying', info => console.log(info.toString()));
await atv.close();
```

Apps, accounts, text input, and Companion-only navigation/media/volume/power control need a second, Companion pairing: `startCompanionPairing()` then `connectCompanion()`. A successful Companion control reply acknowledges acceptance, not a resulting UI, playback, volume, or power-state change; observe the normal state events separately. See the [library guide](https://github.com/energee/node-appletv-remote/blob/main/docs/library.md).

`DeviceSession` offers typed, per-operation routing over separately paired AirPlay, standalone
MRP, Companion and legacy DMAP clients. It selects before sending and never replays a failed
action through another protocol; see [routed sessions](docs/library.md#routed-sessions).
This orchestration API is synthetic-peer verified; physical mixed-protocol validation is pending.

## CLI

```bash
atv scan                          # find Apple TVs
atv pair                          # AirPlay pairing (enter the PIN shown on the TV)
atv companion-pair                # Companion pairing, needed for Companion-only controls/apps/accounts/text
atv remote                        # interactive remote over configured paired protocols
atv command play                  # one-shot routed control
atv state                         # normalized now-playing snapshot
atv volume 40                     # absolute volume when the selected provider advertises it
atv app launch com.netflix.Netflix
atv text set "search words"
atv --help                        # every command
```

Credentials and endpoint hints use `~/.atv-storage.json`; every command takes an optional `deviceId` and defaults to the most recent eligible paired record. Legacy files are imported non-destructively. See the [CLI reference](https://github.com/energee/node-appletv-remote/blob/main/docs/cli.md).

## Tested on

| Model | Identifier | tvOS |
|---|---|---|
| Apple TV 4K | AppleTV6,2 | 26.6 |
| Apple TV HD | AppleTV5,3 | 26.6 |

Other models and tvOS versions are untested; reports are welcome.

## Status

"Verified" means checked on the models above (#30). Everything else is covered by protocol fixtures and loopback tests only.

| Feature | Status |
|---|---|
| Discovery, AirPlay and Companion pairing | Verified |
| Navigation/media/power over Companion alone | Navigation, play/pause and sleep/wake verified |
| Navigation, media commands, button tap/double-tap/hold, touch swipes | Verified over MRP |
| Apps, accounts, power state, app launch by URL | Verified; power is read from MRP, so a sleeping TV reports `off` |
| Volume | Absolute set/read verified with AirPods output; TV speakers do not allow absolute volume |
| Audio output routing | Add/remove verified; `setOutputDevices` and routing errors unverified (#46) |
| IPv6 (global, ULA, link-local) | Verified for MRP and Companion |
| AirPlay 2 audio streaming (`RaopStream`) | Verified, incl. WAV input, ffmpeg-decoded MP3 and cancel; remote (URL) input unverified; RAOP text/artwork/progress requests accepted but not displayed on tvOS 26.6 (#22, #80) |
| Text entry and text-focus events | Verified (focus, set, clear) |
| Media URL and temporary local-file playback | HLS verified; progressive MP4 does not play on these two models on tvOS 26.6 ([known limitation](https://github.com/energee/node-appletv-remote/blob/main/docs/audio-and-playback.md#known-limitations)) |
| Legacy Apple TV 2/3 (DMAP), legacy RAOP receivers, HomePods | Unverified, no hardware available |
| Standalone MRP (tvOS < 15), Companion-only devices | Unverified, no hardware available |

## Documentation

- [Changelog](https://github.com/energee/node-appletv-remote/blob/main/CHANGELOG.md): what changed in each release, breaking changes and known limitations
- [CLI reference](https://github.com/energee/node-appletv-remote/blob/main/docs/cli.md): every command, device selection, timing knobs
- [Library guide](https://github.com/energee/node-appletv-remote/blob/main/docs/library.md): pairing, remote control, now-playing state, Companion, lifecycle, gestures, routing, events
- [Media URL playback and audio streaming](https://github.com/energee/node-appletv-remote/blob/main/docs/audio-and-playback.md): `AirPlayPlaybackSession` (`playUrl` and `playFile`), `RaopStream`, `wavPcm`, `extractRaopMetadata`, `LegacyPairSetup`
- [Legacy Apple TV 2/3 (DMAP)](https://github.com/energee/node-appletv-remote/blob/main/docs/dmap.md)
- [Internals](https://github.com/energee/node-appletv-remote/blob/main/docs/internals.md): protocol stack, discovery association rules, raw Companion messages
- [Contributing](https://github.com/energee/node-appletv-remote/blob/main/CONTRIBUTING.md)

## License

MIT
