# node-appletv-remote

[![npm](https://img.shields.io/npm/v/node-appletv-remote)](https://www.npmjs.com/package/node-appletv-remote)
[![license](https://img.shields.io/npm/l/node-appletv-remote)](./LICENSE)

Control an Apple TV from Node.js, as a library or a CLI. It speaks AirPlay 2, MRP (Media Remote Protocol) and Companion Link over your local network, with no native dependencies.

I built this to learn how the Apple TV handshake works, and because the older Node libraries no longer work with current Apple TVs. Inspired by the original [node-appletv](https://github.com/evandcoleman/node-appletv).

**Existing remote-control status:** tested on an Apple TV 4K. Newly added protocol APIs are synthetic/loopback tested, not hardware validated. Discovery, pairing, navigation, media controls, now-playing, playback queue and artwork all work. Some apps (YouTube, for one) don't expose artwork.

## CLI

```bash
atv scan                          # find Apple TVs (and AirPlay receivers' psi output IDs)
atv pair                          # AirPlay pairing (enter the PIN shown on the TV)
atv companion-pair                # Companion pairing, needed for apps/accounts/power

atv command <command> [action] [deviceId]  # send one command, e.g. `atv command play`
atv command up doubleTap [deviceId]  # action: singleTap (default), doubleTap, hold
atv remote [deviceId]             # interactive remote; type `help` for commands
atv state [deviceId]              # what's playing
atv queue [deviceId]              # playback queue
atv artwork [deviceId] [out.jpg]  # save current artwork
atv messages [deviceId]           # stream raw MRP messages until Ctrl+C
atv keyboard [deviceId]           # stream keyboard/text events
atv --help                       # complete syntax and available keys

# AirPlay/MRP playback
atv stop [deviceId]
atv seek 120.5 [deviceId]          # absolute position in seconds (>= 0)
atv skip-forward 30 [deviceId]    # positive seconds; skip-backward also supported
atv shuffle songs [deviceId]      # off, albums, songs
atv repeat all [deviceId]         # off, track, all
atv volume 40 [deviceId]          # absolute volume, 0..100
atv output list [deviceId]        # selected outputs, tab-separated ID and name
atv output add <psi-uuid>[,<psi-uuid>...] [deviceId]  # also remove, set

# Companion only (requires atv companion-pair)
atv text set "search words" [deviceId]  # prints the new text; fails if no field is focused
atv text append " more" [deviceId]
atv text clear [deviceId]
atv text focus [deviceId]         # focused, unfocused, or unknown
atv app list [deviceId]           # tab-separated bundle ID and name
atv app launch com.netflix.Netflix [deviceId] # bundle ID or URL / URL scheme
atv account list [deviceId]       # tab-separated account ID and name
atv account switch <account-id> [deviceId]
atv power [deviceId]             # on, off, or unknown
atv command guide [deviceId]      # extra Companion button
atv click [action] [deviceId]     # touch click; same actions as command
atv swipe 100 500 900 500 250 [deviceId]  # x1 y1 x2 y2 (0..1000) and duration ms (1..60000)

# Legacy Apple TV 2/3 (DMAP, experimental; see below)
atv dmap-pair 192.168.1.10        # this computer's LAN IPv4; enter the shown PIN on the TV
atv dmap play [deviceId]          # up down left right select menu top_menu play pause stop play_pause next previous volume_up volume_down
atv dmap state [deviceId]         # title, artist, album, play state

# Legacy RAOP audio (experimental; see below)
atv raop-stream 192.168.1.20 track.pcm  # raw PCM16LE stereo 44.1 kHz, no WAV header
```

Credentials are saved to `~/.atv-credentials.json`. Leave out `deviceId` to use the most recently paired device. An explicit selector matches a paired device ID case-insensitively; blank or unmatched selectors fail instead of silently selecting the last device. Each device's last working address is cached in `~/.atv-devices.json`, so commands skip the network scan. If the TV has moved, the CLI rescans automatically.

Playback and output commands open only AirPlay/MRP; text/app/account/power/click/swipe commands and extra buttons open only Companion. `command` (alias `cmd`) still accepts `skip_forward` / `skip_backward` for the app's default interval; use the hyphenated commands to specify seconds. Extra Companion buttons are `channel_up`, `channel_down`, `screensaver`, `guide`, `page_up`, and `page_down` (not available in the MRP-only interactive remote). An optional action (`singleTap`, `doubleTap`, `hold`; case-insensitive) may follow navigation/HID keys and Companion buttons; media keys, `wake`, `suspend`, skips and `home_hold` reject it before connecting. When both an action and a device are given, an unrecognized action word is rejected as an invalid action instead of being treated as a device selector.

Output IDs must be the receiver's AirPlay **`psi`** UUID, which `atv scan` prints as `psi=...`; its `deviceid` (MAC) and `pi` are ignored by the TV and time out after five seconds. Comma-separated IDs are trimmed and must be unique and nonblank (checked before connecting). `output add/remove/set` print the confirmed selected outputs afterward; `atv output set ""` is rejected, so the CLI cannot clear all outputs.

`atv dmap-pair` advertises this computer as a Remote on the given local IPv4 interface, prints a random PIN, waits up to five minutes for the TV, and stores the pairing GUID in `~/.atv-dmap.json` (separate from modern credentials, keyed by the device ID shown in the selection list: the AirPlay `deviceid` when the TV also advertises AirPlay on that address, which Apple TV 2/3 normally do, otherwise `dmap:<instance>`). It fails immediately once five wrong PINs lock pairing or the window expires; Ctrl+C cancels, closes the callback server and unpublishes the advertisement. `atv dmap` logs in with that GUID; `[deviceId]` selects among DMAP pairings the same way. Its address is cached like the others. `state` is a one-shot snapshot; the CLI does not use the library's DMAP push updates.

`atv raop-stream` resolves the receiver's `_raop._tcp` TXT record by browsing mDNS for up to five seconds at the given IPv4 address, then streams the file with `RaopStream`. It supports only receivers that accept unencrypted legacy PCM without a PIN (receivers requiring a legacy seed, password or HAP fail before streaming). Ctrl+C cancels and tears the session down.

Numeric values must be finite decimal numbers in the documented range. Required IDs must be nonblank. Quote text to preserve spaces; `atv text set ""` explicitly sets empty text. Invalid arguments fail before reading credentials, discovery, or connection. For one-shot commands, operation and connection failures print an error to stderr and exit nonzero; one-shot operations close their connection even on failure. Absolute volume can fail if the TV does not report its output device, and has no effect when the TV offers only relative or no volume control (see #39 below). These commands depend on device/app support and do not bypass pairing. Extra positional arguments are rejected instead of ignored. Progress (including `Requesting ...` lines from state, queue and artwork) goes to stderr so results remain clean on stdout. Empty scans and pairing cancellation/no-device selections retain their existing successful exit behavior.

Two CLI timing knobs guard HID keys, which the Apple TV never acknowledges. Set either to `0` for faster one-shot commands:

- `ATV_SETTLE_MS` (default 500): pause after the MRP handshake before sending anything, for every MRP command (a request sent before the device is ready may be dropped; for a query that would mean waiting out its 10 s timeout). Companion-only commands do not use it. The library defaults to `0`; opt in with `atv.connect(credentials, { settleMs: 500 })`.
- `ATV_POST_SEND_MS` (default 1000): pause after a one-shot key/playback/text/volume/Companion-button/click/swipe/app-launch/account-switch operation, before disconnecting. Read-only queries (`power`, `text focus`, `app list`, `account list`, `state`, `queue`, `artwork`) and `output` commands (which wait for the TV to report the new group) disconnect as soon as their reply arrives. `dmap` commands are HTTP request/response and never wait.

```
$ atv state
Oh, No! Where is my Mouth? by Pit & Penny Stories [Playing] 0.00% (YouTube)
```

**Commands:** `command` (alias `cmd`) accepts the keys below and Companion buttons `guide`, `channel_up`, `channel_down`, `page_up`, `page_down`, and `screensaver`; see `atv --help` for complete syntax.

`up` `down` `left` `right` `select` `menu` `home` `home_hold` `top_menu` · `play` `pause` `play_pause` `next` `previous` `skip_forward` `skip_backward` · `volume_up` `volume_down` · `wake` `suspend`

## Library

```bash
npm install node-appletv-remote
```

Requires Node.js 20.19+ (ESM). Node 18 is end-of-life and no longer supported.

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

const state = await atv.getNowPlaying(); // unified NowPlayingInfo
const rawState = await atv.getState();  // raw SetState, retained for compatibility
const art = await atv.requestArtwork(400, 400); // null if the app has none

await atv.close();
```

### Media results, state and runtime availability

`play`, `pause`, `stop`, `next`, `previous`, seek, shuffle, repeat and skip commands
wait for the reply carrying the request's identifier (5 s timeout; matched by identifier only).
Nonzero `sendError` rejects with both numeric codes; handler status is diagnostic
context, not an independent rejection gate. Explicit
nonzero envelope `errorCode` also rejects; an absent `sendError` or an absent
`SendCommandResult` extension both count as success (NoError). HID keys (including `playPause`) only report successful writes, not
device acknowledgments. Correct concurrent result matching depends on the MRP
transport's request correlation.

`getNowPlaying()`, `nowPlaying` and the `nowPlaying` event share `NowPlayingInfo`.
While connected, `getNowPlaying()` returns the received selected-player snapshot
without sending a queue request when it has explicit playback state (including
unknown/stopped), a queue (including an empty queue), or direct now-playing fields.
A SetNowPlayingClient/SetNowPlayingPlayer routing selection must also have arrived
in this connection; the legacy first-state fallback does not qualify for cache bypass.
Client/player identity and supported commands alone do not qualify, except that a selected
empty client (an idle TV's empty SetNowPlayingClient) with no selected player resolves as nothing playing. If no selected-player
state has arrived, it still requests a queue reply and propagates the 10 s timeout
or transport error. After a routing selection, a successful reply resolves with the
selected player's snapshot (nothing playing if that player has no state), even when the
reply lands on another player. Without a routing selection, a reply without state for the
model's current player rejects with `No active-player state received`. It does not force a refresh
or wait for a future push, and a push during a pending request does not hide that
request's timeout. A successful queue reply may still establish legacy unrouted state
for compatibility, but it must contain state for the model's current player; an
empty/unrelated reply cannot validate an earlier unrouted push.
`getState()` remains the raw correlated SetState queue-request API,
even with a cached snapshot; queue and artwork calls retain their response dependency.
Queue metadata uses its current `location`; item updates merge by identifier.
Direct state updates retain omitted fields; a changed `uniqueIdentifier` clears
old-track metadata. Runtime evidence is discarded on disconnect/reconnect. Inactive players stay separate until
an active client/player message selects them; an empty `SetNowPlayingClient` selects the
empty-bundle client, so an idle TV reports nothing playing. `hasPlayback` distinguishes absent
metadata from paused/stopped playback; `playbackState` retains the device's explicit
state (unknown if not reported). `playerIdentifier` and `appBundleIdentifier`
identify the selected player. Position is a snapshot, not extrapolated. CLI state uses the same summary as
`NowPlayingInfo.toString()` (percentage progress rather than its former time-pair
formatter). Metadata-free explicit Playing/Paused/Interrupted/Seeking states are
printed as their reported state, not "Absent." The raw `playbackQueue` and `supportedCommands` events still expose
messages from any player; normalized `nowPlaying` is active-player-only.

```typescript
const availability = atv.featureAvailability('play');
atv.on('featureAvailability', () => {
  console.log(atv.featureAvailability('setVolume'));
});
```

Availability is `supported` (advertised and enabled), `unavailable` (advertised but
currently disabled), `unsupported` (missing from a received command list), or
`unknown` (no runtime evidence). Media commands use the active player's command
list plus client defaults. Volume uses explicit relative/absolute capability
flags and the known output UID. The flags come from a pushed VolumeControlAvailability
(type 17), from the reply (type 63) to the GetVolumeControlCapabilities request the
handshake sends (tvOS 26 does not always push type 17), and from
VolumeControlCapabilitiesDidChange (type 64) pushes for our output device. A type 63 or
64 without capabilities leaves earlier flags unchanged. Other public capabilities remain `unknown` rather
than being guessed from model or service presence. Availability is advisory and
may change at any time; device errors still reject. The event has no payload:
re-query the capabilities relevant to your application.

**Volume on tvOS 26 (#39):** on the tested devices `volume` stayed `undefined` and the
`volume` event never fired when the TV offered no absolute volume, and `setVolume` sent
but changed nothing. Check `featureAvailability('setVolume')` first. On tvOS 26.6 an
AppleTV6,2 reports volume control unavailable (most likely because the TV's volume is not
under its control over CEC or IR; not confirmed), and an AppleTV5,3 reports relative only (`volumeUp`/`volumeDown` supported, `setVolume`
unsupported). Both answer a GetVolume request with 0 for every output UID, and their
UpdateOutputDevice descriptors carry no volume.

**Idle Apple TV state (#10):** when no app has a loaded item, an Apple TV (seen on
the HD AppleTV5,3 and the 4K AppleTV6,2) answers the queue request with a typeless
reply carrying our identifier and `errorCode` 35 ("Could not find the specified now
playing client"). A typed request now rejects on such a reply instead of waiting out
its 10 s timeout; the rejection carries `errorCode`. `getNowPlaying()` treats 35 as
nothing playing (or the pushed state, if it arrived first); `getState()`,
`requestPlaybackQueue()` and `requestArtwork()` reject. Hardware-checked on the HD
while playing, paused and after `stop`: queue replies and pushed state both work
once an app has a loaded item. With nothing loaded, the HD sends no reply at all
to `play`, so that command still times out after 5 s.

The handshake sends ClientUpdatesConfig, GetKeyboardSession and
GetVolumeControlCapabilities without waiting for their replies. Media commands and the legacy heartbeat correlate replies by identifier;
queue requests additionally require the SetState type, except that a same-identifier
error reply also settles them (#10).

#### Sanitized #10 capture (operator-run only)

Register `mrpDiagnostic` **before** `connect()` on an existing `AppleTV` instance.
Import `MRPDiagnostic` as a type from `node-appletv-remote` when annotating listeners.
Use a bounded capture connection; its in-memory token map keeps the 1024 most recently used identifiers (LRU), so recurring client/player tokens stay stable while request identifiers churn.
The event emits only relevant init/state message types (including the
GetVolumeControlCapabilities request, volume capability replies and changes, and tvOS 26
types 104/105), direction, opaque
connection-local request/client/player tokens, and `matchedRequest` on receives
(type plus identifier match before dispatch). Missing identifiers remain omitted;
no default route is invented. Tokens allow equality comparisons within a connection,
not identification across devices/sessions. It excludes CryptoPairing, keys, auth
frames, device names/addresses, keyboard text, metadata, artwork and item identifiers.
Send entries indicate an attempt, not successful receipt by the TV. Diagnostic
observer exceptions are reported with a fixed message, never their error content,
and do not interrupt protocol delivery. No trace is persisted by the library. This is not a
raw packet dump; do not share the separate `message`/`playbackQueue` payloads or logs
from verbose auth tooling.

```typescript
// Use your own authorized device/credentials setup; never print credentials.
const started = Date.now();
atv.on('mrpDiagnostic', diagnostic => {
  console.log(JSON.stringify({ ms: Date.now() - started, ...diagnostic }));
});
await atv.connect(credentials);
try {
  await new Promise(resolve => setTimeout(resolve, 2000)); // capture window, not a fix
  try {
    const info = await atv.getNowPlaying();
    console.log(JSON.stringify({ operation: 'getNowPlaying', playbackState: info.playbackState,
      hasPlayback: info.hasPlayback })); // no titles/app names
  } catch {
    console.log(JSON.stringify({ operation: 'getNowPlaying', result: 'rejected' }));
    // Record locally whether this was the exact type-4 timeout; do not dump the error/payload.
  }
  try {
    await atv.getState(); // explicitly compare raw queue behavior; never print the reply
    console.log(JSON.stringify({ operation: 'getState', result: 'resolved' }));
  } catch {
    console.log(JSON.stringify({ operation: 'getState', result: 'rejected' }));
  }
} finally {
  await atv.close();
}
```

1. After separate hardware/credential authorization, build this checkout (`npm run build`).
   Run the capture on HD and 4K using the same transport and app. Record model and
   actual tvOS version manually, replacing device names/addresses with `HD`/`4K`.
2. Use the physical remote to start, pause, then stop/exit the same test content.
   Make a fresh connection/capture for each state on each device (six captures).
   Also keep one connection open through those three transitions to compare pushes
   and client/player selection. Do not use library playback commands for the capture.
3. Compare init types 15/38/16/24, pushed state/routing types 4/46/47/53/54/55/56/72,
   and queue type 32 followed by type 4. Check whether type 4 is absent, identifierless,
   carries a different token, matches the request, or routes to an unselected player.
   Record exact timeout vs other failure locally and share only sanitized outcomes.

**Remaining blocker:** no authorized HD/4K trace establishes whether initial state
pushes arrive, which client/player is selected, or how the failing queue response
is identified/typed. Offline fixtures cannot establish that hardware behavior.

### Legacy Apple TV 2/3 (DMAP, experimental)

`scan()` also browses `_touch-able._tcp` and `_appletv-v2._tcp` and exposes
`dmapPort` and `dmapAddress`. DMAP joins a modern device only on an address also
advertised by its primary protocol, never by hostname or a copied instance name.
The selected DMAP address must be shared, even if another address is listed first.
`port` remains the AirPlay port (0 if
none was advertised). `createClient(device)` prefers usable modern AirPlay, then enabled standalone MRP, then DMAP; explicit `'dmap'`, `'mrp'`, or `'airplay'` overrides are supported. A Companion-only device (no AirPlay, MRP or DMAP) gets an `AppleTV` for `connectCompanion()`; an explicit `'airplay'` request on it still throws. An AirPlay
advertisement on an old TV does not imply modern AirPlay 2/MRP support.
`new AppleTV(device)` handles AirPlay/standalone MRP, not DMAP, and rejects pairing/connect
on DMAP-only devices instead of contacting port 0. Discovery labels unmatched
services as "Legacy DMAP device" since a service is not proof of Apple TV hardware.

```typescript
import { scan, createClient, DmapClient, DmapPairing } from 'node-appletv-remote';

const [device] = await scan({ filter: d => !!d.dmapPort });
const remote = createClient(device, 'dmap'); // or new DmapClient(device)

// address MUST be this computer's LAN IPv4 address, not the TV's address.
const pairing = new DmapPairing({ name: 'Node Remote', address: '192.168.1.10', pin: '1234' });
try {
  await pairing.start();
  // Select "Node Remote" in the TV's Remotes menu and enter 1234 on the TV.
  // Wait for that step to complete before calling finish (throws until paired).
  const legacyGuid = pairing.finish(); // 0x + 16 hex digits; persist privately
  await remote.connect(legacyGuid);
} finally {
  await pairing.close(); // unpublish and close the callback server
}
await remote.up();
await remote.playPause();
console.log(await remote.getState()); // NowPlayingInfo snapshot
remote.on('nowPlaying', info => console.log(info.toString()));
remote.on('pushError', err => console.error(err)); // polling stopped; see retry note below
remote.startPushUpdates(); // long-polls play status on a second connection
await remote.setPosition(30);
await remote.volumeUp();
const png = await remote.requestArtwork(512); // Buffer | null
console.log(remote.capabilities());
remote.close(); // also stops push updates
```

Existing legacy pairing GUIDs and Home Sharing UUIDs can be supplied directly to
`DmapClient.connect(string)`. Modern `Credentials`, HAP JSON and Ed25519 keys
**do not work with DMAP** and are rejected. Home Sharing IDs are not automatically
exposed from TXT records. DMAP uses unencrypted local HTTP and the mandated legacy
MD5 PIN challenge; use only on a trusted LAN. Discovery is unauthenticated and
cannot establish server identity. Verify the selected address and port before
supplying a pairing GUID or Home Sharing UUID; constructing `DmapClient` with an
explicit endpoint is a caller trust decision, not authentication. The pairing callback binds to the
specified local IPv4 interface and advertises only that address, so the firewall
must permit inbound connections. Pairing accepts one successful callback, locks
after five wrong PIN callbacks, and expires after five minutes; restart pairing
to retry. Once locked or expired, `finish()` throws a lockout/expiry error instead of
"DMAP remote is not paired", so a polling caller can stop. The attempt budget is global, so any host on the trusted LAN can exhaust it
and deny pairing until restarted. This is legacy PIN authentication, not proof of the TV identity.

Implemented: up/down/left/right touch navigation, select/menu/topMenu,
play/pause/stop/playPause/next/previous, login with bounded 401/403 relogin (concurrent
commands wait for the shared login), and
non-blocking now-playing title/artist/album/playback-state/duration/position. Navigation
attempts touch release on failure without replacing the original error or contacting a
replacement connection.
`cant` is remaining milliseconds, not elapsed; absent/sentinel timing is unknown
(0 in `NowPlayingInfo`).

Media extras, matching what the legacy protocol offers:

- `volumeUp()`/`volumeDown()` send the `volumeup`/`volumedown` control commands. There is
  no absolute `setVolume` on DMAP.
- `setPosition(seconds)` sets `dacp.playingtime` (milliseconds). `skipForward(s)`/`skipBackward(s)`
  are simulated: they read the position and seek by `s` seconds (default 10), clamped at 0,
  and do nothing when the position is unknown.
- `setShuffle(state)` sets `dacp.shufflestate`: DMAP shuffle is only on/off, so
  `ShuffleState.Albums` and `Songs` both turn it on. `setRepeat(state)` sets
  `dacp.repeatstate` (Off/Track/All). Values other than the enum members (including the
  enum's string names such as `'Off'`) are rejected before sending.
- `getState()` and `nowPlaying` also report `genre` (`cang`), `shuffleState` (`cash`; on reads
  as `ShuffleState.Songs`) and `repeatState` (`carp`) from play status. Absent tags leave
  `genre` empty and the states `undefined`. These `NowPlayingInfo` fields are DMAP-only for
  now; MRP snapshots leave them empty/undefined.
- `requestArtwork(width = 512, height = 0)` fetches `nowplayingartwork` and returns the raw
  image bytes (usually PNG) or `null` when the device sends none; the size is a request and
  must be a non-negative integer.
- `startPushUpdates()` long-polls `playstatusupdate` with the server's `cmsr` revision on a
  second HTTP connection, emitting `nowPlaying` for the initial state and each change.
  Failures (including a reply without a revision) stop polling and emit `pushError`; there
  is no automatic retry. To retry, call `startPushUpdates()` again, except after a
  persistent 401/403: that ends the session, so call `connect()` first (otherwise
  `startPushUpdates()` throws "not connected"). `stopPushUpdates()`, `close()` and a new
  `connect()` end it without an error event, and a stopped poll never sends another request.
  Exceptions thrown by `nowPlaying`/`pushError` listeners are rethrown asynchronously as
  uncaught exceptions and do not stop polling.
- The long poll has no inactivity timeout, because it legitimately blocks until play status
  changes. A TV that vanishes without closing the connection (power loss, Wi-Fi drop) is
  detected only by TCP keepalive, which Node's keep-alive agent enables on the socket. How
  long that takes depends on the Node/libuv version and OS. On Node 24 on macOS the
  socket measured 1 s idle, 1 s interval, 10 probes, so roughly 10 s. Older libuv sets only
  the idle time, leaving the OS probe interval and count (macOS defaults: 75 s x 8, about
  10 minutes). Until then neither `nowPlaying` nor `pushError` fires. Use your own
  watchdog (for example `stopPushUpdates()` plus a `getState()` probe) if you need faster detection.

Capabilities report navigation and push updates as `available` (protocol support, not
hardware verification); media, seek, skip, shuffle, repeat and artwork as `unknown`
(app-dependent); metadata (`title`, `artist`, `album`, `genre`, `duration`, `elapsedTime`,
`playbackState`, `shuffleState`, `repeatState`) as `available` only after its tag appears; and
`volumeUp`/`volumeDown` from the last play status's volume-controllable (`cavc`) tag:
`available`, `unavailable`, or `unknown` before any status. Apps, accounts, power,
keyboard and `setVolume` are `unsupported` because DMAP has no such commands.
**Breaking:** capability keys now match method names; the earlier placeholder keys `artwork`,
`volume`, `seek`, `shuffle` and `repeat` were replaced by `requestArtwork`,
`volumeUp`/`volumeDown`, `setPosition`, `setShuffle` and `setRepeat`, and `DmapCapability`
gained the `'unavailable'` member (exhaustive switches over it need a new case). The CLI wraps pairing (`atv dmap-pair`),
these commands and the state snapshot (`atv dmap`).

Fixture and loopback-server tests cover codec bounds, auth, commands, metadata,
volume/seek/shuffle/repeat requests, genre/shuffle/repeat state, artwork, push-update revisions,
stop/restart and stop-during-relogin cancellation, throwing listeners, pairing callbacks and selection. **No Apple TV 2/3 hardware validation has been
performed**; interoperability, remote advertisement/interface selection and
firmware-specific behavior remain unverified.

### Media URL playback (AirPlay 2)

```typescript
import { AirPlayPlaybackSession } from 'node-appletv-remote';

const playback = new AirPlayPlaybackSession(device.address, device.port, credentials);
try {
  await playback.playUrl('https://media.example/movie.mp4', 12.5); // start seconds
  const status = await playback.getStatus(); // playing / paused / idle, duration, position, rate
  // Keep this session open while playing; poll getStatus() as needed.
} finally {
  playback.close(); // stops playback; releases TCP, event, UDP timing and heartbeat resources
}
```

This is actual authenticated media playback, not `launchApp(url)`. The receiver must be able to fetch the HTTP(S) URL directly; web pages and app deep links are not media URLs. AirPlay HAP credentials are supplied by the caller; this API does not read credential files or pair automatically. Each session starts one URL and cannot be reused after closing. `playUrl` resolves when the receiver accepts the setup/play/rate requests, not when playback completes. `idle` means the receiver reports no duration and can also mean startup buffering, so it is not proof that playback ended.

Timing replies are restricted to the connected TCP peer address and, when returned by SETUP, its timing port. Only 32-byte RTP timing requests (payload type `0x52`, or `0xd2` with the marker bit) are answered, whatever their first (version) byte; the reply echoes that byte. Other 32-byte packets get no reply. UDP timing-reply send errors are ignored; timing socket failures still close the session.

HTTP errors, connection loss, malformed status, and `/playback-info` media errors reject and close the failed session. Background heartbeat failures close the session and surface on the next `getStatus`. Requests have a five-second timeout (including URL acceptance); receivers taking longer to probe media will fail. Replies are limited to 1 MiB; duplicate Content-Length framing headers and all Transfer-Encoding responses are rejected. Binary and XML playback-info property lists are supported. A rejected `/play` is surfaced immediately; the authenticated SETUP sequence is not retried.

The implementation uses same-socket HAP verification, NTP/event SETUP, feedback, RECORD, binary-plist `/play`, rate/property requests, and `/playback-info`. Stop closes the dedicated connection; it does not send a teardown command. Tests use a synthetic loopback receiver and generated keys. **Media/codec compatibility and URL playback on physical hardware remain unverified.** IPv6 receivers are supported: the timing socket binds the matching family and the Host header and RTSP URI bracket the literal. Legacy AirPlay 1, mirroring, DRM, local-file hosting, and transcoding are not supported.

### Legacy RAOP audio (experimental, partial #22)

`RaopStream` sends actual paced UDP audio, not a playback stub. It is a separate
one-shot API, not `AppleTV`/MRP playback. Legacy receivers accepting unencrypted
PCM/L16 over IPv4 UDP are supported, with optional legacy PIN pair-verification.
No hardware verification has been performed for this API; the existing Apple TV
4K status does not apply. Modern HAP-authenticated Apple TVs, HomePods, AirPlay 2
buffered/encrypted audio, RSA/FairPlay/MFi authentication, password digest auth,
legacy PIN pair-setup, ALAC, transcoding, multiroom, live sources, artwork,
progress, and automatic RAOP discovery are excluded. `atv raop-stream` wraps this API
for PIN-less receivers (it does not supply a `legacySeed`).

Supply an explicit IPv4 endpoint and its actual `_raop._tcp` TXT record. Required
capabilities are `cn` containing `0` (PCM), `et` containing `0` (unencrypted), `tp`
containing `UDP`, `sr=44100`, `ss=16`, and `ch=2`; `pw` must be absent or `false`.
`sf`/`flags` are parsed as hexadecimal: PIN/legacy-pairing bits `0x8`/`0x200`
require caller-supplied `legacySeed`; password bit `0x80` is unsupported. Malformed
flags and unsupported access control (`pw=true`, `act=2`, `acl=1`) fail closed.
`ft`/`features` bits 40 or 43 without 38 or 48 fail closed in the constructor.
Text metadata additionally requires `md` containing `0`.
Other negotiation and non-200 responses fail closed (except optional feedback),
without reading stored credentials.

`ft`/`features` bit 38 or 48 selects the AirPlay 2 profile instead (current Apple
TVs and HomePods). The legacy-only checks above (`cn`, `et`, `tp`, `sr`/`ss`/`ch`
and the `0x8`/`0x200` seed rule; Apple TVs advertise `flags=0x244`) do not apply to
it; password and access-control bits still fail closed. `stream()` requires
`credentials` (HAP `Credentials` from `PairSetup`) for AirPlay 2 and rejects
`credentials` on legacy receivers and `legacySeed` on AirPlay 2, all before taking
ownership of the source. **AirPlay 2 audio setup is not implemented yet**: with
valid credentials `stream()` still rejects with `AirPlay 2 audio streaming is not
implemented yet`, before taking the source.

```typescript
import { createReadStream } from 'node:fs';
import { RaopStream } from 'node-appletv-remote';

// address, raopPort and raopTxt come from your receiver's _raop._tcp service.
const sender = new RaopStream(address, raopPort, raopTxt);
const cancellation = new AbortController();
await sender.stream(createReadStream('track.pcm', { highWaterMark: 65536 }), {
  signal: cancellation.signal,
  volume: 50,
  metadata: { title: 'Track', artist: 'Artist', album: 'Album' },
});
```

`RaopPcmSource` is a Buffer, Node Readable, or `AsyncIterable<Buffer>` containing
**finite, non-empty raw signed PCM16 little-endian, stereo, 44.1 kHz, interleaved
left/right**, with no WAV header. Total length must be divisible by four. Keep
Buffer input unchanged until completion. Async-iterable chunks must be nonempty
Buffers of at most 65,536 bytes; Node Readables are paused and read in bounded
pieces even if Node has coalesced larger internal buffers. Arbitrary sample/packet
boundaries are reassembled. Source staging retains one copied chunk plus one
1,408-byte PCM packet and does not pull another chunk until needed by the paced
consumer. Wire packets and the separately bounded 1,000-packet resend cache add
about 1.42 MB; RTSP headers and bodies each have a 64 KiB cap. Replies use the
shared `parseHTTPMessage` framing (duplicate Content-Length and any Transfer-Encoding
are rejected); the status line and a single matching CSeq are validated locally. Producer/Readable
internal buffering is additional and remains the producer's responsibility. Slow sources
or delayed event loops that fall more than 100 ms behind after playback starts are
resynchronized: pacing re-anchors to the current time and a fresh sync packet is sent,
so the lost time is skipped rather than flooded or aborted. This is not a live-source
jitter buffer; the receiver may hear a gap. Samples become
big-endian L16 on the wire, in 352-frame packets; the last packet is zero-padded. The sender
negotiates ANNOUNCE/SETUP/RECORD/FLUSH, requires UDP unicast receiver ports, and
uses a fixed 66,150-frame latency (1.5 seconds). Other returned
`Audio-Latency` values are rejected rather than silently assumed compatible.

The TCP route selects the local interface; all three UDP sockets bind only to
that address. Timing requests are accepted only after SETUP validates the receiver
address and timing port; requests before negotiation or from other ports are ignored.
SETUP must return `server_port` and `control_port`; an omitted `timing_port` defaults
to 0 (an explicit `timing_port=0` is treated the same), and
timing requests are then accepted from any port at the receiver address.
Playback uses monotonic deadlines, one-second RTP/NTP synchronization, NTP timing
replies anchored to the same monotonic clock as sync (wall-clock changes do not
step the session clock), and a bounded 1,000-packet retransmission cache. Requests are checked for
length/type and retransmissions are restricted to the negotiated control peer,
with at most 100 packets per request and per second. Optional timing/resend send
errors do not terminate audio. Abandoned RTSP replies are discarded so cancellation
can finish teardown.
Long event-loop or source stalls re-anchor pacing rather than flooding a receiver. A paced silence tail
keeps sync alive until buffered audio drains. `stream()` resolves after the tail
and bounded best-effort TEARDOWN; failures/cancellation reject and close all sockets,
timers and history. An instance cannot be reused. A supplied signal must be an
AbortSignal. Ownership begins after input, options, cancellation and one-shot validation: the caller must not consume a
streamed source concurrently. Rejection before ownership leaves the source with
the caller, who must close it. After ownership, every exit destroys the Readable or
requests the iterator's `return()`, including EOF; custom iterators should make
cleanup idempotent. Cancellation interrupts pending `next()` without
waiting for arbitrary producer code; unresolved `next()`/`return()` operations are
observed but cannot block socket teardown. A custom producer must make those
operations settle itself. Pass the caller's signal to producer I/O too if user cancellation
should interrupt it; the sender does not inject a signal into an arbitrary producer, but internal sender failures cannot abort that caller-owned signal;
use a caller-owned producer controller and abort it in the `stream()` rejection
handler/finally block to cancel producer I/O. Internal cancellation is private.
Pre-aborted calls reject with `Error('RAOP aborted')`; cancellation after ownership
preserves the supplied signal's reason (which can be any value), rather than
promising a uniform `AbortError` across all APIs.

Legacy keepalive probes `POST /feedback` once before audio. Only a 200 response
starts 25-second periodic feedback, with no overlapping feedback requests. Unsupported
feedback responses disable the initial probe or are best-effort during playback.
A periodic request that times out is logged to stderr with a
`[RAOP]` prefix and playback continues; transport loss and malformed replies still
terminate the stream.
Feedback and sync stop on EOF/drain, cancellation or failure. Receivers rejecting
feedback have no invented fallback keepalive; their long-stream idle-timeout
behavior remains unverified.

While playback is active, `setVolume(percent)` and `setMetadata({ title, album,
artist })` update the receiver. Volume is 0..100, maps linearly to -30..0 dB, and
zero sends -144 dB mute; decimal wire values are rounded to two places. Metadata uses UTF-8 DMAP `mlit`/`minm`/`asal`/`asar` tags
(maximum 4,096 bytes per field). Both methods reject outside an active session.

The L16 network byte order conversion is checked with independent byte fixtures.
Legacy pair-verify sends two raw `/pair-verify`
HTTP/1.1 POSTs before ANNOUNCE on the same socket, using AirPlay/320.20 and no CSeq.
Authentication accepts serialized HTTP replies without CSeq; audio setup and feedback
remain RTSP/1.0 with CSeq correlation. A canceled authentication request closes the
connection, so a late anonymous HTTP reply cannot satisfy a later request. Seed-derived X25519 and Ed25519 keys,
SHA-512-derived AES-CTR key/IV, and receiver ciphertext advancement before the
client signature. Supply `stream(source, { legacySeed })` only with a 32-byte seed
from prior **legacy AirPlay PIN pairing**; HAP `Credentials`, HAP `clientLTSK` and
DMAP GUIDs are not interchangeable. No key/credential files are read automatically.
This legacy exchange proves the client's paired key to the
receiver, does not verify a receiver identity, and enables no transport encryption;
use only on a trusted LAN. Tests use synthetic keys, a verifying loopback peer,
and independent public legacy verification byte vectors.

Modern RAOP is a distinct unfinished profile, not an extra HAP flag here. It
requires HAP-encrypted control, plist base/audio SETUP, an event
channel and per-packet ChaCha20-Poly1305 with audio AAD and nonce; none is claimed
by this legacy L16 implementation. Internally, the RTSP control client can already
switch to HAP-encrypted framing and send the CSeq-less HTTP pairing requests
(`/pair-verify`, `/pair-pin-start`, `/pair-setup`) that this profile needs, but
`RaopStream` does not use it yet (loopback-tested only). Physical interoperability
remains unverified.

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

// Text input into the focused field; each resolves with the field's resulting text
await atv.setText('apple tv');               // 'apple tv'
await atv.insertText(' remote');             // 'apple tv remote'
await atv.getText();                         // read without editing
await atv.clearText();                       // ''

// Is a text field focused? import { KeyboardFocusState } from 'node-appletv-remote'
atv.textFocusState;                          // KeyboardFocusState.Focused / Unfocused / Unknown
atv.on('textFocusState', (state) => {});     // fires when focus changes (session opened by connectCompanion)
await atv.fetchTextFocusState();             // re-ask the TV; also updates atv.textFocusState
```

Text input uses Companion RTI: restart the text session (`_tiStop`/`_tiStart`), read the session UUID and current text from the reply, then send `_tiC` edits. A real Apple TV 4K ignored the older MRP `TextInputMessage`, so text input now needs `connectCompanion()`, and it rejects with `No text field is focused` instead of silently succeeding. `deleteText()` still sends the MRP Delete action.

Text focus comes from the same RTI session: a `_tiStart` reply carries a `_tiD` archive only while a text field is focused. `connectCompanion()` sends `_tiStart` right after `_systemInfo`, because the TV pushes `_tiStarted`/`_tiStopped` events only to clients with an open RTI session; a TV that rejects it just emits `companionError` and leaves the state `unknown`. Every `_tiStart` reply (from connect, `fetchTextFocusState()` or a text edit) and every `_tiStarted`/`_tiStopped` event updates `textFocusState`, which emits only on change. It starts as `unknown` and returns to `unknown` when Companion closes. This is fixture-tested only; whether a given tvOS version pushes these events to this client is not hardware-verified (tracked in #30). The MRP `keyboard` event is separate and only fires on devices that still send KeyboardMessage.

`connectCompanion()` sends `_systemInfo` after pair-verify. Without it, a real Apple TV 4K answers app, account and power requests with "No request handler", so a rejected `_systemInfo` fails the connect. The touch session's `_sessionStop` can return "Session not found" when an AirPlay/MRP connection is also open; `stopTouch()` treats that as already stopped. Verified on an Apple TV 4K (tvOS, AppleTV6,2).

### Connection and request lifecycle

Root test commands exclude nested worktrees, dependency directories and generated `dist` copies.

MRP requests match the outgoing message UUID and, when one is given, the expected response type
(media commands match by UUID only), so concurrent
same-type replies can arrive out of order. Unsolicited updates remain visible as events;
the DeviceInfo handshake separately accepts a type-based, identifierless response.
HTTP/RTSP setup replies have a fixed 5-second timeout; MRP replies default to 5 seconds. RTSP replies match
CSeq; Companion replies match their transfer ID.

Transport loss, authentication failure, decrypt failure, or write errors invalidate the
connection and reject pending requests, including pre-authentication waiters. AirPlay
reports errors from control, event, and data channels through `error`; Companion uses
`companionError` on AppleTV. AppleTV forwards `error` only when observed; pending operations still reject without an error listener. Register a listener to observe asynchronous failures. The FEEDBACK
heartbeat never overlaps another heartbeat. The CLI registers an AirPlay error listener before
setup and reports asynchronous transport errors instead of crashing. Low-level connection
classes emit `error` only when a listener exists; pending work still rejects and `close`
still fires without one. There is no automatic reconnect or retry.

`await atv.close()` shuts down local sockets without RTSP TEARDOWN. If touch was started,
it first cancels the gesture and attempts Companion touch/session cleanup (an unfinished touch startup is abandoned, not awaited); that cleanup
is best-effort: failures are ignored and close still closes both transports and resolves (call `stopTouch()` first to observe
teardown errors; both are retained there in an AggregateError). Without touch registrations, socket shutdown is immediate. Explicit close resets runtime availability once and notifies after both transports are cleared.
Repeated close is safe. A second connect on
an open or connecting connection rejects. Close cancels pending TCP setup as well as
protocol waiters; await the canceled setup promise before reusing a low-level connection
instance. AppleTV can install a replacement immediately; stale instance events and failures
cannot clear it or forward stale state/events into it. In-flight MRP decoding is discarded
when its session closes, even if the transport instance reconnects. Messages batched in one
DataStream frame are handled in order, each after the previous finishes. State listeners run before
request waiters resume (also when a listener throws); user listener exceptions are not
swallowed as decode failures. Socket-dispatched listener exceptions surface as uncaught
exceptions, not unhandled promise rejections.
Intentional close suppresses late write errors. Synchronous Companion write failures throw
as well as terminating the session. Invalid HTTP/RTSP
Content-Length values, headers over 64 KiB, bodies or DataStream frames over 16 MiB, and acknowledgment encryption/write failures terminate the session
rather than hanging or escaping socket callbacks. DataStream sizes smaller than the 32-byte
header reject instead of leaving a non-progressing receive loop. `close` (or `companionClose`) fires only
after the matching `connect` (or `companionConnect`); a failed or canceled setup reports only through its rejected promise. Failed setup
does not leave a command-capable AppleTV connection. A queue-request timeout is not proof that
nothing is playing; only the device's error 35 reply is (#10).

### Button actions, gestures, and audio routing

These library APIs are protocol-tested; MRP button modes, touch swipes and output add/remove were exercised on an Apple TV 4K (#30). The CLI exposes them as `command <key> [action]`, `click`, `swipe` and `output`.

```typescript
await atv.up('doubleTap');
await atv.home('hold'); // same one-second hold as homeHold()
await atv.guide('hold'); // Companion buttons also accept actions

// Companion must be connected. Touch/service registration starts lazily.
await atv.touchAction(100, 100, TouchAction.Press);
await atv.touchAction(500, 100, TouchAction.Hold);
await atv.touchAction(500, 100, TouchAction.Release);
await atv.click('doubleTap');
await atv.swipe(100, 500, 900, 500, 250, abortController.signal);
await atv.stopTouch(); // close() also releases and stops registrations

console.log(atv.outputDevices); // current selected outputs [{ name, identifier }]
atv.on('outputDevices', devices => console.log(devices));
const [speaker] = await scan({ filter: d => d.name === 'Kitchen' });
await atv.addOutputDevices([speaker.airplayPsi!]); // the speaker's AirPlay psi
await atv.removeOutputDevices([speaker.airplayPsi!]);
await atv.setOutputDevices([speaker.airplayPsi!]);
```

Import `TouchAction` from the package; `InputAction` and `OutputDevice` are exported types. HID button methods accept `'singleTap'` (default), `'doubleTap'`, or `'hold'`. MRP taps preserve the existing 50ms press and flush; each double tap repeats that complete sequence, and hold lasts 1000ms. Existing Companion button taps release immediately; touch clicks use 20ms taps or 1000ms holds and phase 5. Media commands, wake/suspend, skip commands, and the fixed `home_hold` alias reject non-default action arguments to `sendKeyCommand`.

Touch coordinates must be integers in 0..1000; swipes require an integer duration of 1..60000ms and interpolate at 16ms intervals. Hold/release require an active press. Overlapping high-level gestures and a second press without release are rejected. Close/stop also cancel held clicks; close both connections before explicitly reconnecting Companion. Abort rejects the swipe and releases its finger while still connected; disconnect invalidates local session state rather than pretending to send cleanup on a dead connection. Gesture completion means events were transmitted, not that a visible Apple TV action was confirmed.

Output listing reflects DeviceInfo/DeviceInfoUpdate selected groups, not discovery of available speakers. Routing IDs are each receiver's AirPlay `psi` TXT value, exposed by `scan()` as `airplayPsi`; on tvOS 26 its MAC-style `deviceid` and its `pi` are ignored and the operation times out. IDs must be unique nonempty strings; only `setOutputDevices([])` accepts an empty list. One routing operation may be pending at a time. Routing sends `ModifyOutputContextRequest` (message type 48, protobuf extension 52), with both regular and cluster-aware device IDs. Types 65 (`UpdateOutputDevice`) and 66 (`RemoveOutputDevices`) are not routing acknowledgements; unsolicited messages of these types neither confirm nor reject an operation. A nonzero envelope error rejects routing only when its identifier matches the outgoing UUID, regardless of message type. Routing resolves once the reported group matches the operation (immediately if it already does; for `set`, the reporting group leader is not counted unless requested), and rejects on failed transmission/connection close or lack of confirmation within five seconds. It never optimistically changes the output list. A successful write or non-error envelope alone is not confirmation.

Button actions, touch clicks and swipes, cancellation release, and output add/remove are hardware-verified; `setOutputDevices` and UUID-correlated routing errors are not (see [Hardware verification status](#hardware-verification-status)). No hardware or stored credentials are accessed by the regression tests.

### Events

```typescript
atv.on('nowPlaying', (info) => console.log(info.toString()));  // NowPlayingInfo
atv.on('volume', (level) => {});           // 0–100
atv.on('powerState', (state) => {});       // after subscribePowerState()
atv.on('supportedCommands', (cmds) => {}); // SupportedCommand[]
atv.on('playbackQueue', (queue) => {});
atv.on('keyboard', (kb) => {});            // MRP KeyboardMessage focus (older tvOS)
atv.on('textFocusState', (state) => {});   // Companion RTI focus; KeyboardFocusState, after connectCompanion()
atv.on('message', (msg) => {});            // every raw MRP message; not sanitized
atv.on('mrpDiagnostic', (d: MRPDiagnostic) => {}); // opt in before connect; safe routing tokens
atv.on('close', () => {});
atv.on('error', (err) => {});
```

`Message.type` is the numeric discriminator sent on the wire, even when `MessageType`
does not name it, so `toString()` shows `Unknown(n)` with the real number. A message
without a type field also reports type 0 (`Unknown(0)`); test `'type' in msg.payload`
to tell it from a real type 0. tvOS 26
also sends `PlayerClientProperties` (104, extension 86), `OriginClientProperties`
(105, extension 87), `UpdateOutputDevice` (65, extension 69, identity and volume
descriptor fields only) and a `uniqueIdentifier` UUID on every envelope (field 85).
A message with no type field, only `identifier` and `uniqueIdentifier`, also arrives on
connect. Typeless messages that carry our identifier are usually replies to our requests
(#10), so this is most likely a reply to a handshake request; that is not confirmed.

## Hardware verification status

Checked on an Apple TV 4K (AppleTV6,2) and an Apple TV HD (AppleTV5,3), both tvOS 26.6, in #30.

**Verified:** button tap/double-tap/hold; touch swipes, and finger release when a swipe is cancelled; Companion apps, accounts and power; app launch by URL; media commands; IPv6 (global, ULA and link-local) for MRP and Companion; output add/remove through a receiver's `psi`; volume capability reporting (#39); MRP message types 104/105 (#40).

**Not verified** (protocol- or fixture-tested only; reports from real devices welcome):

- Routing errors matched by UUID, and `setOutputDevices`. tvOS 26.6 silently ignores an unknown output ID, so the only failure signal observed is the five-second timeout (#46).
- Reading absolute volume. Neither test setup offers it (#39).
- Companion-only devices, legacy Apple TV 2/3 (DMAP) and standalone MRP on tvOS < 15. No such devices were available.
- Text entry and text-focus events. They need someone watching the screen.
- Legacy RAOP audio streaming. No legacy RAOP receiver was available.

## How it works

1. **Discovery:** independent AirPlay, Companion, standalone MRP, and legacy DMAP services.
2. **Pair-setup** (first time only): SRP with the PIN shown on the TV.
3. **Pair-verify:** X25519 + Ed25519 using the stored credentials.
4. **AirPlay session:** encrypted RTSP, plus an event channel and a data channel.
5. **MRP** runs as protobuf over the data channel. A `/feedback` heartbeat every 2s keeps it alive.

MRP's own CryptoPairing is skipped on the AirPlay tunnel because the data channel is already HAP-encrypted.

```
src/
├── appletv.ts      # AppleTV class (start here)
├── connection.ts   # AirPlay session + MRP data channel
├── discovery.ts    # mDNS scanning
├── auth/           # HAP pair-setup / pair-verify
├── companion/      # Companion Link: OPACK, framing, pairing
├── dmap/           # legacy codec, HTTP session, reverse pairing
├── raop/           # partial legacy PCM RTP streaming
├── airplay-playback.ts # dedicated URL playback session
├── mrp/            # MRP message builders + generated schema.ts
├── proto/          # .proto sources (build input only)
├── util/           # crypto, TLV, HTTP, HAP framing, AirPlay 2 event channel
└── cli/            # the `atv` command
```

## Discovery and transport selection

`DiscoveredDeviceInfo.port` remains the AirPlay port, and is **0 when AirPlay is absent**. `companionPort` and `mrpPort` are independent capabilities, not substitute AirPlay ports. `mrpEnabled` is false for Darwin build 19+ (tvOS 15+), where the legacy MRP advertisement no longer indicates a usable transport. Unknown builds retain legacy MRP eligibility.

`AppleTV.connect()` and `startPairing()` preserve the AirPlay tunnel when advertised, otherwise select enabled standalone MRP. Companion-only devices use `connectCompanion()` and `startCompanionPairing()`; calling the MRP methods fails before opening a socket. Standalone credentials use the existing `Credentials` format but must be paired with the selected protocol; AirPlay pairing does not imply legacy MRP pairing. A returned PairSetup owns its open pairing carrier: always call `finish(pin)` or `destroy()`; abandoning it without either intentionally leaves pairing open. `PairSetup.clientId` is a public readonly controller pairing identifier (a random UUID per instance); it is sent in M5 and returned as `clientId` in the finished credentials.

A standalone MRP connection sends a heartbeat (a GenericMessage) every 30 s, never overlapping another. Any reply carrying the request's identifier counts, whatever its type; a miss is retried once immediately, and a second miss fails the connection.

Discovery associates modern services by compatible advertised identity, primary-protocol hostname, or overlapping primary-protocol addresses, never by display name. AirPlay `deviceid` and MRP `macAddress` share a MAC namespace; MRP `UniqueIdentifier` and Companion `rpMRtID` share an MRP namespace. Other cross-protocol ID equality does not establish an association. Conflicting IDs within a namespace keep devices separate. Same-protocol records with disjoint addresses and different SRV hosts remain separate even when their IDs match; duplicate device IDs are ambiguous, not verified identities. Primary endpoint overlap is scoped to the selected protocol host. Records matching multiple groups remain separate instead of bridging them, independent of arrival order; an ambiguous result must not be treated as a verified TV.

DMAP instance names are not universal device IDs: `deviceId`/`identifiers` use `dmap:<instance>` instead of a raw instance name. Migrate stored legacy instance lookups to that prefix. DMAP requires direct address overlap with the primary protocol and never joins by hostname or instance name alone. `identifiers` retains the modern aliases for cached credential lookup, but every alias is unauthenticated mDNS data, not proof of identity. The primary `deviceId` prefers AirPlay, then MRP, then DMAP, then Companion. If no ID is advertised, discovery falls back to hostname/service instance (not IP). Changed advertisements can change the primary ID; match stored IDs against `identifiers` too, as the CLI does. These association checks prevent unrelated endpoint selection, not mDNS spoofing or an attacker advertising the same endpoint.

IPv4 is preferred when advertised; global/ULA IPv6 and explicitly scoped link-local IPv6 (for example `fe80::1234%en0`) are accepted. Unscoped link-local, loopback, unspecified, and multicast addresses are excluded. Use unbracketed addresses for constructors; the RTSP layer brackets IPv6 authorities. `companionAddress`, `mrpAddress`, and `dmapAddress` prefer an address shared with the primary protocol. Modern services joined by compatible identity or hostname can retain disjoint service-specific endpoints; joined DMAP endpoints must be shared. Dual-stack/multihomed advertisements for the same primary identity retain their usable addresses for overlap checks. No automatic connection retry across alternate addresses is added. Exceptions in `scan` filter/until callbacks reject the scan promise after stopping discovery.

Tests use synthetic peers only; IPv6 network discovery and older-tvOS hardware interoperability still require operator validation. An AirPlay advertisement alone does not prove AirPlay 2 MRP or URL-playback compatibility. `createClient` treats known AppleTV1-3 model advertisements as legacy AirPlay; explicit protocol selection remains available.

## Advanced: raw Companion messages

For anything not wrapped yet, send Companion messages yourself:

```typescript
const reply = await atv.sendCompanionRequest('FetchAttentionState', new Map());
atv.sendCompanionMessage('_interest', new Map([['_regEvents', ['SystemStatus']]]));
```

- A reply carrying an `_em` error rejects with `Companion <id> failed: <_em>` instead of resolving with an empty `_c`.
- Plain content is wrapped as `{ _i, _t, _c, _x }`. `_t` is 2 for a request and 1 for a message. If you pass a prebuilt envelope (with `_t`, `_c` or `_x`), only `_i` and `_x` get filled in.
- Wrap whole numbers in `new OpackFloat(n)` when the protocol expects a float, such as skip seconds or volume 0/1. Use `bigint` for unsigned 64-bit IDs.
- Request IDs stay in 1..127, since Apple TVs read larger single-byte IDs as negative. A timed-out ID stays reserved for 30s so a late reply can't resolve the wrong request.

The OPACK and framing tests use independent wire fixtures, including published OPACK examples.

## Development

```bash
npm install
npm run build        # also regenerates src/mrp/schema.ts
npm test             # or npm run test:watch
```

With pnpm, `pnpm install --frozen-lockfile` works as is: `pnpm-workspace.yaml` pre-approves the esbuild and protobufjs build scripts that pnpm 10+ otherwise blocks.

The MRP schema is compiled into `src/mrp/schema.ts`, so no `.proto` files are read at run time and the package bundles cleanly. After editing a `.proto` (or adding one to `PROTO_FILES` in `scripts/gen-proto.mjs`), run `npm run gen:proto` and commit the result.

Use `protobufjs >=8.8.1` within major 8; the manifest and pnpm lockfile exclude older vulnerable releases. Fresh npm installs and pnpm's locked installs must both pass. Patched protobufjs enforces proto2 closed enums and drops undeclared values, so `ProtocolMessage.type` is declared `int32`: every discriminator, known or not, decodes as its number (#40). `ProtocolMessage.Type` remains as the reference list; add new values there and to the TypeScript `MessageType` enum. The bare HID flush is `GENERIC_MESSAGE = 42`. `SendButtonEvent` is message type 39 with payload extension field 43, not message type 43. Independent wire fixtures test these values in addition to builder/decoder round trips.
