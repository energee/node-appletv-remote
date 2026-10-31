# Changelog

## Unreleased

### Fixed

- Pairing commands release stdin after answered prompts so a completed command can exit
  even when its input pipe remains open (#89).
- URL and local-file playback can opt into `startupTimeoutMs` to reject and close sessions that
  never reach receiver-confirmed playing/paused. Receiver error events now surface as playback
  failures; queue-accepted behavior remains the default (#45).

## 0.5.0

Hardware-tested on an Apple TV 4K (1st gen, AppleTV6,2) and an Apple TV HD (AppleTV5,3), both on
tvOS 26.6 (23L773). Everything else is covered by protocol fixtures and loopback tests.

### Breaking changes

- **Node.js 20.19 or newer** is required (#56).
- **Credentials move to `~/.atv-storage.json`** (#93). Existing `atv pair` credentials, DMAP GUIDs
  and cached addresses are imported on first use; the old files are left untouched.
- **CLI device selectors no longer fall back to the last-paired TV.** A selector that matches no
  paired device is an error. Selectors match the record key, a known alias, or the stored device
  name in full (`"Family Room"`, any case).
- **DMAP `capabilities()` keys** `artwork`, `volume`, `seek`, `shuffle` and `repeat` are renamed to
  their method names, and `DmapCapability` gains `'unavailable'` (#52).

### Added

- Companion-only Apple TVs: navigation, media, volume, wake and sleep over Companion alone (#92).
- Operations routed across every configured protocol, with per-operation preferences (#100).
- Versioned credential storage with a library storage and settings API (#93).
- Targeted (unicast) mDNS discovery: `scan({ hosts })` and `atv scan --host` (#99).
- Structured JSON CLI output and event streams: `atv --json` (#96).
- AirPlay 2 audio streaming (`RaopStream`) with WAV input, legacy RAOP receivers and legacy
  AirPlay PIN pairing (#22, #59–#68).
- `atv raop-stream` decodes other formats and HTTP(S) sources with ffmpeg (#94).
- Audio metadata extraction (`extractRaopMetadata`) with artwork and progress (#97).
- Local media playback through a temporary HTTP server (`playFile`) (#98).
- Richer normalized now-playing metadata (#95).
- Keyboard text-focus state from Companion RTI (#49); text input now goes over Companion RTI (#35).
- DMAP (Apple TV 2/3): volume steps, seek, skip, shuffle, repeat, artwork and push updates (#52).
- CLI: action modes (double tap, hold), touch, output routing, DMAP and RAOP commands (#54).
- Optional Companion pairing name for Remote App and Devices (#102).
- Read-only MRP volume queries (#103); volume updates renew after an output change (#105).
- The AirPlay `psi` on scan results, needed for output routing (#51).

### Fixed

- URL playback uses the tvOS 18+ remote-control queue (#43, #38).
- tvOS 26: unknown MRP message types are kept, and volume capabilities are read (#53, #40, #39).
- Power reads from MRP, so a sleeping Apple TV reports `off` instead of an error (#107).
- tvOS 26.4+: Companion power and app-list requests work after a `TVRCSessionStart` (#106).
- Scans re-send their queries at 1 s and 3 s, so one lost reply no longer hides a TV (#106).
- Device names from targeted discovery keep their case (#106).
- Plex paused no longer reads as Playing (#106).
- Companion pairing explains an expired PIN (#106).
- Stale DMAP addresses fail fast (#58); queue requests settle on device error replies (#41).
- Faster connects: early scan, cached address, `TCP_NODELAY`, configurable waits (#7).

### Known limitations

- **MP4 URL and file playback on Apple TV HD and Apple TV 4K (1st gen), tvOS 26.6.** The TV fetches
  the file but never becomes ready to play; HLS plays normally. pyatv's tvOS 26 rework behaves the
  same on these TVs, and other people report MP4 working on Apple TV 4K (3rd gen). See
  [docs/audio-and-playback.md](docs/audio-and-playback.md#known-limitations).
- tvOS 26.6 accepts RAOP title, artwork and progress but does not display them (#22, #80).
- `atv raop-stream` streams only to receivers that need no PIN or HAP pairing, which excludes Apple
  TVs; use `RaopStream` with HAP credentials from the library.
- Seeking a playing URL item has no effect on tvOS 26 (#44); unreachable URLs never report an error (#45).
- Unverified on hardware: legacy Apple TV 2/3 (DMAP), legacy RAOP receivers, HomePods, standalone MRP
  (tvOS < 15) and Companion-only devices.
