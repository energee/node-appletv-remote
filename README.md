# node-appletv-remote

[![npm](https://img.shields.io/npm/v/node-appletv-remote)](https://www.npmjs.com/package/node-appletv-remote)
[![license](https://img.shields.io/npm/l/node-appletv-remote)](./LICENSE)

Control an Apple TV from Node.js, as a library or a CLI. It speaks AirPlay 2, MRP (Media Remote Protocol) and Companion Link over your local network, with no native dependencies.

I built this to learn how the Apple TV handshake works, and because the older Node libraries no longer work with current Apple TVs. Inspired by [pyatv](https://pyatv.dev/) and the original [node-appletv](https://github.com/evandcoleman/node-appletv).

**Existing remote-control status:** tested on an Apple TV 4K. Newly added protocol APIs are synthetic/loopback tested, not hardware validated. Discovery, pairing, navigation, media controls, now-playing, playback queue and artwork all work. Some apps (YouTube, for one) don't expose artwork.

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
atv keyboard [deviceId]           # stream keyboard/text events
atv --help                       # complete syntax and available keys

# AirPlay/MRP playback and text
atv stop [deviceId]
atv seek 120.5 [deviceId]          # absolute position in seconds (>= 0)
atv skip-forward 30 [deviceId]    # positive seconds; skip-backward also supported
atv shuffle songs [deviceId]      # off, albums, songs
atv repeat all [deviceId]         # off, track, all
atv volume 40 [deviceId]          # absolute volume, 0..100
atv text set "search words" [deviceId]
atv text append " more" [deviceId]
atv text clear [deviceId]

# Companion only (requires atv companion-pair)
atv app list [deviceId]           # tab-separated bundle ID and name
atv app launch com.netflix.Netflix [deviceId] # bundle ID or URL / URL scheme
atv account list [deviceId]       # tab-separated account ID and name
atv account switch <account-id> [deviceId]
atv power [deviceId]             # on, off, or unknown
atv command guide [deviceId]      # extra Companion button
```

Credentials are saved to `~/.atv-credentials.json`. Leave out `deviceId` to use the most recently paired device. An explicit selector matches a paired device ID case-insensitively; blank or unmatched selectors fail instead of silently selecting the last device. Each device's last working address is cached in `~/.atv-devices.json`, so commands skip the network scan. If the TV has moved, the CLI rescans automatically.

Playback/text commands open only AirPlay/MRP; app/account/power commands and extra buttons open only Companion. `command` (alias `cmd`) still accepts `skip_forward` / `skip_backward` for the app's default interval; use the hyphenated commands to specify seconds. Extra Companion buttons are `channel_up`, `channel_down`, `screensaver`, `guide`, `page_up`, and `page_down` (not available in the MRP-only interactive remote).

Numeric values must be finite decimal numbers in the documented range. Required IDs must be nonblank. Quote text to preserve spaces; `atv text set ""` explicitly sets empty text. Invalid arguments fail before reading credentials, discovery, or connection. For one-shot commands, operation and connection failures print an error to stderr and exit nonzero; one-shot operations close their connection even on failure. Absolute volume can fail if the TV does not report its output device. These commands depend on device/app support and do not bypass pairing. Extra positional arguments are rejected instead of ignored. Progress goes to stderr so app/account list and power results remain clean on stdout. Empty scans and pairing cancellation/no-device selections retain their existing successful exit behavior.

Two CLI timing knobs guard HID keys, which the Apple TV never acknowledges. Set either to `0` for faster one-shot commands:

- `ATV_SETTLE_MS` (default 500): pause after the MRP handshake before sending anything. The library defaults to `0`; opt in with `atv.connect(credentials, { settleMs: 500 })`.
- `ATV_POST_SEND_MS` (default 1000): pause after a one-shot key/playback/text/Companion operation, before disconnecting.

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

const state = await atv.getNowPlaying(); // unified NowPlayingInfo
const rawState = await atv.getState();  // raw SetState, retained for compatibility
const art = await atv.requestArtwork(400, 400); // null if the app has none

await atv.close();
```

### Media results, state and runtime availability

`play`, `pause`, `stop`, `next`, `previous`, seek, shuffle, repeat and skip commands
wait for `SendCommandResult` (5 s timeout). Nonzero `sendError` rejects with both numeric codes; handler status is diagnostic
context, not an independent rejection gate (matching pinned pyatv). Explicit
nonzero envelope `errorCode` also rejects; missing result status rejects
as malformed. HID keys (including `playPause`) only report successful writes, not
device acknowledgments. Correct concurrent result matching depends on the MRP
transport's request correlation.

`getNowPlaying()`, `nowPlaying` and the `nowPlaying` event share `NowPlayingInfo`.
Queue metadata uses its current `location`; item updates merge by identifier.
Direct state updates retain omitted fields; a changed `uniqueIdentifier` clears
old-track metadata. Runtime evidence is discarded on disconnect/reconnect. Inactive players stay separate until
an active client/player message selects them. `hasPlayback` distinguishes absent
metadata from paused/stopped playback; `playbackState` retains the device's explicit
state (unknown if not reported). `playerIdentifier` and `appBundleIdentifier`
identify the selected player. Position is a snapshot, not extrapolated. CLI state uses the same summary as
`NowPlayingInfo.toString()` (percentage progress rather than its former time-pair
formatter). The raw `playbackQueue` and `supportedCommands` events still expose
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
flags and the known output UID. Other public capabilities remain `unknown` rather
than being guessed from model or service presence. Availability is advisory and
may change at any time; device errors still reject. The event has no payload:
re-query the capabilities relevant to your application.

**Apple TV HD limitation (#10):** pairing and remote keys can work while `state`,
queue and artwork requests time out waiting for MRP type 4. A 500 ms settle delay
has not resolved the reported AppleTV5,3 case. No HD-specific fix is established.
Offline source comparison only establishes that pyatv reads cached pushed player
state instead of requiring a queue response for every state read. Diagnosing the
remaining transport/device difference needs sanitized exchanges from HD and 4K
while playing, paused and stopped; this implementation does not fabricate that evidence.

Reference: pyatv [v0.18.0, commit d88abc960e188d3cd2498d19117e75d7711d8600](https://github.com/postlund/pyatv/tree/d88abc960e188d3cd2498d19117e75d7711d8600),
`protocols/mrp/player_state.py`, MRP result/player protobufs and runtime feature handling.

### Legacy Apple TV 2/3 (DMAP, experimental)

`scan()` also browses `_touch-able._tcp` and `_appletv-v2._tcp` and exposes
`dmapPort` and `dmapAddress`. DMAP joins a modern device only on an address also
advertised by its primary protocol, never by hostname or a copied instance name.
The selected DMAP address must be shared, even if another address is listed first.
`port` remains the AirPlay port (0 if
none was advertised). `createClient(device)` prefers usable modern AirPlay, then enabled standalone MRP, then DMAP; explicit `'dmap'`, `'mrp'`, or `'airplay'` overrides are supported. An AirPlay
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
console.log(await remote.getState()); // NowPlayingInfo snapshot, not push updates
console.log(remote.capabilities());
remote.close();
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
to retry. The attempt budget is global, so any host on the trusted LAN can exhaust it
and deny pairing until restarted. This is legacy PIN authentication, not proof of the TV identity.

Implemented: up/down/left/right touch navigation, select/menu/topMenu,
play/pause/stop/playPause/next/previous, login with bounded 401/403 relogin (concurrent
commands wait for the shared login), and
non-blocking now-playing title/artist/album/playback-state/duration/position. Navigation
attempts touch release on failure without replacing the original error or contacting a
replacement connection.
`cant` is remaining milliseconds, not elapsed; absent/sentinel timing is unknown
(0 in `NowPlayingInfo`). Capabilities report navigation as `available` (protocol
support, not hardware verification), media commands as `unknown` (app-dependent),
and metadata as `available` only after its tag appears. Apps, accounts, power,
keyboard, artwork, volume, seek, shuffle, repeat and push updates are
`unsupported` in this minimal implementation. There is no DMAP CLI pairing/control
flow; the existing CLI remains modern-only, although scan includes legacy TVs.

Wire behavior is based on [pyatv v0.18.0 DMAP sources](https://github.com/postlund/pyatv/tree/v0.18.0/pyatv/protocols/dmap).
Fixture and loopback-server tests cover codec bounds, auth, commands, metadata,
pairing callbacks and selection. **No Apple TV 2/3 hardware validation has been
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

Timing replies are restricted to the connected TCP peer address and, when returned by SETUP, its timing port. UDP timing-reply send errors are ignored; timing socket failures still close the session.

HTTP errors, connection loss, malformed status, and `/playback-info` media errors reject and close the failed session. Background heartbeat failures close the session and surface on the next `getStatus`. Requests have a five-second timeout (including URL acceptance); receivers taking longer to probe media will fail. Replies are limited to 1 MiB; duplicate Content-Length framing headers and all Transfer-Encoding responses are rejected. Binary and XML playback-info property lists are supported. Unlike pyatv's player, a rejected `/play` is surfaced immediately rather than retrying the whole authenticated SETUP sequence.

The implementation follows [pyatv 0.18.0](https://github.com/postlund/pyatv/tree/d88abc960e188d3cd2498d19117e75d7711d8600): same-socket HAP verification, NTP/event SETUP, feedback, RECORD, binary-plist `/play`, rate/property requests, and `/playback-info`. Stop closes the dedicated connection, matching `AirPlayStream.stop`; it does not send an invented teardown command. Tests use a synthetic loopback receiver and generated keys. **Media/codec compatibility and URL playback on physical hardware remain unverified.** This session currently requires an IPv4 connection. Legacy AirPlay 1, mirroring, DRM, local-file hosting, and transcoding are not supported.

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

### Connection and request lifecycle

Root test commands exclude nested worktrees, dependency directories and generated `dist` copies.

MRP requests match the outgoing message UUID and expected response type, so concurrent
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
it first cancels the gesture and attempts Companion touch/session cleanup (an unfinished touch startup is abandoned, not awaited); cleanup failure
still closes both transports and rejects (both teardown failures are retained in an AggregateError). Without touch registrations, socket shutdown is immediate. Explicit close resets runtime availability once and notifies after both transports are cleared.
Repeated close is safe. A second connect on
an open or connecting connection rejects. Close cancels pending TCP setup as well as
protocol waiters; await the canceled setup promise before reusing a low-level connection
instance. AppleTV can install a replacement immediately; stale instance events and failures
cannot clear it or forward stale state/events into it. In-flight MRP decoding is discarded
when its session closes, even if the transport instance reconnects. State listeners run before
request waiters resume (also when a listener throws); user listener exceptions are not
swallowed as decode failures. Socket-dispatched listener exceptions surface as uncaught
exceptions, not unhandled promise rejections.
Intentional close suppresses late write errors. Synchronous Companion write failures throw
as well as terminating the session. Invalid HTTP/RTSP
Content-Length values, headers over 64 KiB, bodies or DataStream frames over 16 MiB, and acknowledgment encryption/write failures terminate the session
rather than hanging or escaping socket callbacks. DataStream sizes smaller than the 32-byte
header reject instead of leaving a non-progressing receive loop. `close` (or `companionClose`) fires only
after the matching `connect` (or `companionConnect`); a failed or canceled setup reports only through its rejected promise. Failed setup
does not leave a command-capable AppleTV connection. Receiver compatibility (including
Apple TV HD state responses) still requires device evidence; a timeout is not proof that
nothing is playing.

### Button actions, gestures, and audio routing

These library APIs follow [pyatv 0.18.0](https://github.com/postlund/pyatv/tree/d88abc960e188d3cd2498d19117e75d7711d8600). They are protocol-tested, not yet hardware-verified here. The CLI has no action-mode, touch, swipe, or output-routing commands.

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
await atv.addOutputDevices(['speaker-uid']);
await atv.removeOutputDevices(['speaker-uid']);
await atv.setOutputDevices(['speaker-uid']);
```

Import `TouchAction` from the package; `InputAction` and `OutputDevice` are exported types. HID button methods accept `'singleTap'` (default), `'doubleTap'`, or `'hold'`. MRP taps preserve the existing 50ms press and flush; each double tap repeats that complete sequence, and hold lasts 1000ms. Existing Companion button taps release immediately; touch clicks use 20ms taps or 1000ms holds and phase 5. Media commands, wake/suspend, skip commands, and the fixed `home_hold` alias reject non-default action arguments to `sendKeyCommand`.

Touch coordinates must be integers in 0..1000; swipes require an integer duration of 1..60000ms and interpolate at 16ms intervals. Hold/release require an active press. Overlapping high-level gestures and a second press without release are rejected. Close/stop also cancel held clicks; close both connections before explicitly reconnecting Companion. Abort rejects the swipe and releases its finger while still connected; disconnect invalidates local session state rather than pretending to send cleanup on a dead connection. Gesture completion means events were transmitted, not that a visible Apple TV action was confirmed.

Output listing reflects DeviceInfo/DeviceInfoUpdate selected groups, not discovery of available speakers. IDs must be unique nonempty strings; only `setOutputDevices([])` accepts an empty list. One routing operation may be pending at a time. Routing sends `ModifyOutputContextRequest` (message type 48, protobuf extension 52), with both regular and cluster-aware device IDs. Types 65 (`UpdateOutputDevice`) and 66 (`RemoveOutputDevices`) are not routing acknowledgements; unsolicited messages of these types neither confirm nor reject an operation. A nonzero envelope error rejects routing only when its identifier matches the outgoing UUID, regardless of message type. Routing resolves once the reported group matches the operation (immediately if it already does; for `set`, the reporting group leader is not counted unless requested), and rejects on failed transmission/connection close or lack of confirmation within five seconds. It never optimistically changes the output list. A successful write or non-error envelope alone is not confirmation.

Hardware gates: verify tap/double-tap/hold timing and effects on Apple TV, touch clicks/swipes and release on cancellation/disconnect, and grouping/ungrouping real AirPlay speakers including UUID-correlated routing errors. No hardware or stored credentials are accessed by the regression tests.

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

1. **Discovery:** independent AirPlay, Companion, standalone MRP, and legacy DMAP services.
2. **Pair-setup** (first time only): SRP with the PIN shown on the TV.
3. **Pair-verify:** X25519 + Ed25519 using the stored credentials.
4. **AirPlay session:** encrypted RTSP, plus an event channel and a data channel.
5. **MRP** runs as protobuf over the data channel. A `/feedback` heartbeat every 2s keeps it alive.

MRP's own CryptoPairing is skipped on the AirPlay tunnel because the data channel is already HAP-encrypted, [same as pyatv](https://pyatv.dev/documentation/protocols/).

```
src/
├── appletv.ts      # AppleTV class (start here)
├── connection.ts   # AirPlay session + MRP data channel
├── discovery.ts    # mDNS scanning
├── auth/           # HAP pair-setup / pair-verify
├── companion/      # Companion Link: OPACK, framing, pairing
├── dmap/           # legacy codec, HTTP session, reverse pairing
├── airplay-playback.ts # dedicated URL playback session
├── mrp/            # MRP message builders + generated schema.ts
├── proto/          # .proto sources (build input only)
├── util/           # crypto, TLV, HTTP helpers
└── cli/            # the `atv` command
```

## Discovery and transport selection

`DiscoveredDeviceInfo.port` remains the AirPlay port, and is **0 when AirPlay is absent**. `companionPort` and `mrpPort` are independent capabilities, not substitute AirPlay ports. `mrpEnabled` is false for Darwin build 19+ (tvOS 15+), where the legacy MRP advertisement no longer indicates a usable transport. Unknown builds retain legacy MRP eligibility, matching pyatv 0.18.0.

`AppleTV.connect()` and `startPairing()` preserve the AirPlay tunnel when advertised, otherwise select enabled standalone MRP. Companion-only devices use `connectCompanion()` and `startCompanionPairing()`; calling the MRP methods fails before opening a socket. Standalone credentials use the existing `Credentials` format but must be paired with the selected protocol; AirPlay pairing does not imply legacy MRP pairing. A returned PairSetup owns its open pairing carrier: always call `finish(pin)` or `destroy()`; abandoning it without either intentionally leaves pairing open.

Discovery associates modern services by compatible advertised identity, primary-protocol hostname, or overlapping primary-protocol addresses, never by display name. AirPlay `deviceid` and MRP `macAddress` share a MAC namespace; MRP `UniqueIdentifier` and Companion `rpMRtID` share an MRP namespace. Other cross-protocol ID equality does not establish an association. Conflicting IDs within a namespace keep devices separate. Same-protocol records with disjoint addresses and different SRV hosts remain separate even when their IDs match; duplicate device IDs are ambiguous, not verified identities. Primary endpoint overlap is scoped to the selected protocol host. Records matching multiple groups remain separate instead of bridging them, independent of arrival order; an ambiguous result must not be treated as a verified TV.

DMAP instance names are not universal device IDs: `deviceId`/`identifiers` use `dmap:<instance>` instead of a raw instance name. Migrate stored legacy instance lookups to that prefix. DMAP requires direct address overlap with the primary protocol and never joins by hostname or instance name alone. `identifiers` retains the modern aliases for cached credential lookup, but every alias is unauthenticated mDNS data, not proof of identity. The primary `deviceId` prefers AirPlay, then MRP, then DMAP, then Companion. If no ID is advertised, discovery falls back to hostname/service instance (not IP). Changed advertisements can change the primary ID; match stored IDs against `identifiers` too, as the CLI does. These association checks prevent unrelated endpoint selection, not mDNS spoofing or an attacker advertising the same endpoint.

IPv4 is preferred when advertised; global/ULA IPv6 and explicitly scoped link-local IPv6 (for example `fe80::1234%en0`) are accepted. Unscoped link-local, loopback, unspecified, and multicast addresses are excluded. Use unbracketed addresses for constructors; the RTSP layer brackets IPv6 authorities. `companionAddress`, `mrpAddress`, and `dmapAddress` prefer an address shared with the primary protocol. Modern services joined by compatible identity or hostname can retain disjoint service-specific endpoints; joined DMAP endpoints must be shared. Dual-stack/multihomed advertisements for the same primary identity retain their usable addresses for overlap checks. No automatic connection retry across alternate addresses is added. Exceptions in `scan` filter/until callbacks reject the scan promise after stopping discovery.

Wire behavior is pinned to [pyatv 0.18.0 MRP connection](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/mrp/connection.py), [authentication](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/protocols/mrp/auth.py), and [service identity rules](https://github.com/postlund/pyatv/blob/v0.18.0/pyatv/helpers.py). Tests use synthetic peers only; IPv6 network discovery and older-tvOS hardware interoperability still require operator validation. An AirPlay advertisement alone does not prove AirPlay 2 MRP or URL-playback compatibility. `createClient` treats known AppleTV1-3 model advertisements as legacy AirPlay; explicit protocol selection remains available.

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

Use `protobufjs >=8.8.1` within major 8; the manifest and pnpm lockfile exclude older vulnerable releases. Fresh npm installs and pnpm's locked installs must both pass. Patched protobufjs enforces proto2 closed enums, so every supported message discriminator must be declared in `ProtocolMessage.Type`, not just in the TypeScript `MessageType` enum. The bare HID flush is `GENERIC_MESSAGE = 42`. `SendButtonEvent` is message type 39 with payload extension field 43, not message type 43 ([pinned pyatv 0.18.0 schema](https://github.com/postlund/pyatv/blob/d88abc960e188d3cd2498d19117e75d7711d8600/pyatv/protocols/mrp/protobuf/ProtocolMessage.proto)). Independent wire fixtures test these values in addition to builder/decoder round trips.
