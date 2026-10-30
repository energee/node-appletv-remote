# Library guide

The `AppleTV` API in depth: pairing, remote control, now-playing state, Companion features, connection lifecycle, gestures, audio routing and events. DMAP and audio streaming have their own pages.

## Find and pair

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
`scan()` repeats its multicast queries 1 s and 3 s after starting, so one lost reply no longer hides
a device; keep `timeout` above 3000 ms to get both repeats.

When you already know an address, keep ordinary multicast browsing and query that host's mDNS
endpoint directly:

```typescript
const devices = await scan({ hosts: ['192.0.2.20', 'fe80::1234%en0'], timeout: 5000 });
```

`hosts` accepts only nonempty IP literals. IPv6 link-local literals require an interface scope
such as `%en0`; scoped addresses are preserved. Targeted discovery sends DNS-SD mDNS questions
to UDP port 5353, including the QU bit, and also accepts valid multicast-style replies. It does
not use recursive DNS, bypass routing/firewall/NAT/client-isolation limits, or prove that a
device is reachable, awake, or trusted. Discovery records are unauthenticated: complete normal
pairing and cryptographic connection verification before trusting a result.

Targeted discovery closes its UDP sockets and retry timer with the scan. Closing
during asynchronous socket setup cannot restart querying or leave a retry timer alive.
The per-scan record cache respects TTL expiration and the one-second cache-flush/goodbye
grace period; it is not a persistent device cache. Refreshes and goodbyes still apply
when its bounded capacity prevents adding a new record. Missing target responses do
not suppress ordinary multicast results or prove a device absent/asleep.

### Targeted discovery interoperability

Same-link DNS datagrams were captured privately from the owned Node UDP sockets;
raw TXT, identifiers and network addresses are not published here.

| Responder | Exercised network | Decoded services |
| --- | --- | --- |
| AppleTV6,2 | IPv4 and scoped link-local IPv6 | AirPlay, Companion, RAOP |
| Roku 7104X | IPv4 and IPv6 | AirPlay |
| Vizio E65u-D3 | IPv4 | AirPlay |

All target questions carried QU. The observed target replies came from UDP 5353,
used ten-second record TTLs and did not set cache-flush, consistent with
[RFC 6762 §6.7](https://www.rfc-editor.org/rfc/rfc6762.html#section-6.7)
for queries sent from an ephemeral port. A controlled UDP responder separately
proved actual multicast replies, TTL expiry, cache-flush grace and preservation of
unaffected AAAA records. Scoped Darwin reply addresses were exercised on the native
IPv6 path, not inferred from an IPv4-only fixture.
Apple and Roku packets arrived on the ephemeral query sockets. Vizio packets also
reached the port-5353 listener; UDP receive metadata does not identify the destination
IP, so those packets are not asserted to be multicast. Vizio supplied no AAAA record
in this run.

These are application-layer DNS captures, not Ethernet/IP captures or sleep-proxy
evidence. Routed/subnet-isolated interoperability remains unverified; no result
here establishes NAT traversal, receiver control/media support or cryptographic trust.


## Optional storage

Storage is opt-in: existing explicit credentials never cause filesystem access. Call
`load()` before lookup/update and `save()` when the application decides a successful
pairing or hint update should persist. `FileStorage` is JSON with atomic same-directory
replacement and mode `0600`; it is **not a keychain**. One writer per file is supported.

```typescript
import { FileStorage, CustomStorage } from 'node-appletv-remote';

const storage = new FileStorage('.atv-storage.json');
await storage.load();
storage.setHap(device.deviceId, 'airplay', credentials, [device.deviceId, ...device.identifiers]);
await storage.save();
const credentialsAgain = storage.hap(device.deviceId, 'airplay');

// A keychain/database/cloud adapter implements { load(): Promise<StorageDocument|undefined>,
// save(document): Promise<void> }; pass it to new CustomStorage(adapter).
```

Records separate protocol credentials (`airplay`, `mrp`, `companion`, `raop`, `dmap`)
from unauthenticated endpoint hints. Aliases must be unique; a collision requires explicit
record selection. Explicit caller values take precedence over stored values, which take
precedence over library defaults. Unknown versions, malformed credentials and invalid document
shapes (including JSON `null`, `false`, `0` and `""`) reject on load; they are never silently reset.
Only an adapter result of `undefined` means absent storage (`FileStorage` returns it for a missing
file). A failed reload leaves the previous in-memory document and unsaved changes intact.
Use `remove(key)` for deletion.


## Routed sessions

`DeviceSession` configures independent clients with credentials keyed by their actual pairing
carrier. It does not convert AirPlay keys into standalone MRP or Companion keys. Explicit
credentials cause no storage access. Construct the session before connecting when initial
events matter:

```typescript
import { DeviceSession } from 'node-appletv-remote';

const session = new DeviceSession(device, {
  credentials: { airplay: credentials, companion: companionCredentials },
  transports: { airplay: {}, companion: { required: false } },
  preferences: { wake: 'companion' },
});
session.on('nowPlaying', info => console.log(info.toString()));
session.on('connection', event => console.log(event.protocol, event.state));
session.on('transportError', ({ protocol, error }) => console.error(protocol, error.message));
await session.connect();
try {
  await session.execute('play');
  await session.execute('appList');
  console.log(await session.execute('getNowPlaying'));
} finally {
  await session.close();
}
```

`connectDevice(device, options)` is the convenience form returning an already-ready session.
`execute(operation, ...arguments)` retains the underlying `AppleTV` argument/result types;
`sendKeyCommand` and exported `KEY_OPERATIONS` use the same policy. A DMAP provider rejects
hold/double-tap before transmission instead of silently performing a single action.

Playback/metadata/queue/artwork/routing prefer an eligible AirPlay MRP tunnel, then enabled
standalone MRP. Shared navigation/media/volume operations can next select Companion, then
an implemented DMAP operation. Apps, accounts, text and touch prefer Companion. Power prefers MRP,
which reports sleep in DeviceInfo; a sleeping Apple TV HD rejects every Companion power request.
DMAP normalizes `getNowPlaying` through its existing state request; it does not implement
MRP queue/routing. Known AppleTV1–3 models never become modern AirPlay tunnels.

`preferences` are strict operation overrides: an unimplemented or unconfigured choice rejects
before setup; an unavailable override does not choose another protocol. Without an override,
known unsupported/unavailable implementations are excluded before transmission. `unknown`
means no device evidence, not no implementation. Selection occurs once per call; errors,
timeouts and disconnects after dispatch propagate without replay on another protocol.

Omitting `transports` opens eligible credential-bearing providers. Explicit entries default to
required; required setup failure closes the whole attempt, while optional failure emits
`connection: failed` and `transportError`. `operations: ['getNowPlaying']` limits setup to
providers selected for those operations, as used by one-shot CLI commands.

There is one authoritative source per normalized state event, independent of action availability.
Setup state is coalesced until that source is ready. Loss invalidates its cached state and
availability; later calls may choose another already-ready provider. DMAP terminal authentication
loss participates in that invalidation. `connection` distinguishes `ready`, unexpected `lost`,
intentional `closed`, and optional setup `failed`. `close()` cancels setup and owned transports,
detaches forwarding, and is idempotent. Sessions are single-use and add no reconnect or cross-protocol retry.

Verification uses synthetic MRP/Companion fixtures and a real local HTTP DMAP peer. Physical
mixed-protocol/Companion-only interoperability remains unverified for this session API.

## Remote control

```typescript
await atv.connect(credentials); // MRP remains preferred when both transports are open
await atv.up();                 // also down, left, right, select, menu, home, topMenu
await atv.playPause();          // also play, pause, stop, next, previous
await atv.skipForward();        // app default interval, or skipBackward(30)
await atv.setPosition(120);     // MRP only
await atv.setShuffle(ShuffleState.Songs); // MRP only
await atv.setRepeat(RepeatState.All);     // MRP only
await atv.setVolume(40);        // 0–100; also volumeUp, volumeDown
await atv.wake();               // also suspend
```

With only `connectCompanion(companionCredentials)`, navigation (except `topMenu`), `playPause`, play/pause/next/previous, skip, volume buttons, absolute volume, wake, and suspend use encrypted, acknowledged Companion requests. `stop`, absolute seek, shuffle/repeat, output routing, and now-playing APIs remain MRP-only. Companion HID actions retain single-tap, double-tap, and one-second hold semantics. A completed Companion request means only that the TV accepted the request; navigation, playback, volume, and power state are observational and are not changed optimistically.

## Media results, state and runtime availability

`play`, `pause`, `stop`, `next`, `previous`, seek, shuffle, repeat and skip commands
wait for the reply carrying the request's identifier (5 s timeout; matched by identifier only).
Nonzero `sendError` rejects with both numeric codes; handler status is diagnostic
context, not an independent rejection gate. Explicit
nonzero envelope `errorCode` also rejects; an absent `sendError` or an absent
`SendCommandResult` extension both count as success (NoError). HID keys (including `playPause`) only report successful writes, not
device acknowledgments. Correct concurrent result matching depends on the MRP
transport's request correlation.

`getNowPlaying()`, `nowPlaying` and the `nowPlaying` event share `NowPlayingInfo`.
The numeric timing getters retain their legacy `0` defaults. `hasDuration`,
`hasElapsedTime`, and `hasPlaybackRate` distinguish a source-supplied finite value
(including zero) from missing timing. JSON CLI results use `null` for the latter.
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
state (unknown if not reported), except that Playing with a reported rate of 0 reads as Paused
(Plex on tvOS 26.6 keeps reporting Playing after a pause). `playerIdentifier` and `appBundleIdentifier`
identify the selected player. Position is a snapshot, not extrapolated. CLI state uses the same summary as
`NowPlayingInfo.toString()` (percentage progress rather than its former time-pair
formatter). Metadata-free explicit Playing/Paused/Interrupted/Seeking states are
printed as their reported state, not "Absent." The raw `playbackQueue` and `supportedCommands` events still expose
messages from any player; normalized `nowPlaying` is active-player-only.
`NowPlayingInfo` normalizes queue metadata when MRP supplies it: `mediaType`
(`MediaType.Audio` or `MediaType.Video`), `mediaSubType` (`Music`, `Podcast`,
`AudioBook`, or `ITunesU`), `seriesName`, optional `seasonNumber` and
`episodeNumber`, `genre`, `contentIdentifier`, direct `uniqueIdentifier`, and
the four separate optional `iTunesStore*Identifier` fields. Media type describes
the selected queue item, not the application's bundle. `seriesName` is a series
label, not an episode title. Text fields are `''` when unknown; optional
numbers, enums, and identifiers are `undefined`. Store identifiers are lossless
strings, including decoded 64-bit values. Unknown and unrecognized wire enums
remain `undefined`. DMAP supplies only its existing genre/shuffle/repeat fields;
the MRP-only fields remain unknown. Normalized values always come from the
selected client/player: inactive players' metadata is cached until selected,
then replacement queues, changed direct item IDs, removals, and reconnects clear
the old selected snapshot.


```typescript
const availability = atv.featureAvailability('play');
atv.on('featureAvailability', () => {
  console.log(atv.featureAvailability('setVolume'));
});
```

Availability is `supported` (advertised and enabled), `unavailable` (advertised but
currently disabled), `unsupported` (missing from a received MRP command list), or
`unknown` (no runtime evidence). On a Companion-only connection, `_iMC` media-control
flags provide supported/unavailable evidence for play, pause, next, previous, skip, and
volume; navigation and play/pause stay unknown because `_iMC` has no defined flags for
them. A volume-capable `_iMC` update requests the reported volume and emits `volume` only
for a finite 0–1 reply. Availability is advisory and may change at any time; device
errors still reject. The event has no payload: re-query capabilities relevant to your
application.

**Volume on tvOS 26 (#39):** on the tested devices `volume` stayed `undefined` and the
`volume` event never fired when the TV offered no absolute volume, and `setVolume` sent
but changed nothing. Check `featureAvailability('setVolume')` first. On tvOS 26.6 one
tested Apple TV reports volume control unavailable (most likely because the TV's volume is not
under its control over CEC or IR; not confirmed), and another reports relative only (`volumeUp`/`volumeDown` supported, `setVolume`
unsupported). Both answer a GetVolume request with 0 for every output UID, even an unknown
one, and their UpdateOutputDevice descriptors carry no volume.

**Initial volume (#31):** tvOS sends VolumeDidChange only on a change, so over MRP the library
asks with GetVolume once `featureAvailability('setVolume')` is `supported` and fills in
`volume` (emitting `volume`) right after connecting; a later VolumeDidChange still updates it.
With AirPods (AppleTV6,2, tvOS 26.6) and a HomePod (AppleTV14,1) the reply matched the
level shown on the TV. A reply of 0 is ignored, because one came back while
AirPods were attaching, so an output that really is at 0 stays `undefined` until its volume
changes. A failed or ignored query is retried on the next MRP message, normally a capability
update. Detaching and reattaching AirPods pushes capability changes and VolumeDidChange (a
brief 6.25%, then the real level). When the output loses absolute volume (for example, AirPods
detach and audio returns to TV speakers), `volume` becomes `undefined` and `volume` is emitted
with `undefined`; the next absolute output is queried again.

**Idle Apple TV state (#10):** when no app has a loaded item, an Apple TV (seen on
both tested models) answers the queue request with a typeless
reply carrying our identifier and `errorCode` 35 ("Could not find the specified now
playing client"). A typed request now rejects on such a reply instead of waiting out
its 10 s timeout; the rejection carries `errorCode`. `getNowPlaying()` treats 35 as
nothing playing (or the pushed state, if it arrived first); `getState()`,
`requestPlaybackQueue()` and `requestArtwork()` reject. Hardware-checked
while playing, paused and after `stop`: queue replies and pushed state both work
once an app has a loaded item. With nothing loaded, an Apple TV may send no reply at all
to `play`, so that command still times out after 5 s.

The handshake sends ClientUpdatesConfig, GetKeyboardSession and
GetVolumeControlCapabilities without waiting for their replies. Media commands and the legacy heartbeat correlate replies by identifier;
queue requests additionally require the SetState type, except that a same-identifier
error reply also settles them (#10).

### MRP diagnostics

Register `mrpDiagnostic` **before** `connect()` on an existing `AppleTV` instance.
Import `MRPDiagnostic` as a type from `node-appletv-remote` when annotating listeners.
Use a bounded capture connection; its in-memory token map keeps the 1024 most recently used identifiers (LRU), so recurring client/player tokens stay stable while request identifiers churn.
The event emits only relevant init/state message types (including the
GetVolumeControlCapabilities request, volume capability replies and changes, the GetVolume
request and reply, and tvOS 26
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

## Apps, accounts and power (Companion)

```typescript
await atv.connectCompanion(companionCredentials);

const apps = await atv.appList();            // [{ name, bundleId }]
await atv.launchApp('com.netflix.Netflix');  // or a URL: 'https://youtube.com/watch?v=...'

const accounts = await atv.accountList();    // [{ name, id }]
await atv.switchAccount(accounts[0].id);

await atv.fetchPowerState();                 // PowerState.On / Off / Unknown
atv.subscribePowerState();                   // then listen for 'powerState'
// With only MRP connected, power comes from DeviceInfo.logicalDeviceCount (0 asleep), pushed on every sleep/wake.

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

Text input uses Companion RTI: restart the text session (`_tiStop`/`_tiStart`), read the session UUID and current text from the reply, then send `_tiC` edits. A tested Apple TV ignored the older MRP `TextInputMessage`, so text input now needs `connectCompanion()`, and it rejects with `No text field is focused` instead of silently succeeding. `deleteText()` still sends the MRP Delete action.

Text focus comes from the same RTI session: a `_tiStart` reply carries a `_tiD` archive only while a text field is focused. `connectCompanion()` sends `_tiStart` right after `_systemInfo`, because the TV pushes `_tiStarted`/`_tiStopped` events only to clients with an open RTI session; a TV that rejects it just emits `companionError` and leaves the state `unknown`. Every `_tiStart` reply (from connect, `fetchTextFocusState()` or a text edit) and every `_tiStarted`/`_tiStopped` event updates `textFocusState`, which emits only on change. It starts as `unknown` and returns to `unknown` when Companion closes. This is fixture-tested only; whether a given tvOS version pushes these events to this client is not hardware-verified (tracked in #30). The MRP `keyboard` event is separate and only fires on devices that still send KeyboardMessage.

`connectCompanion()` sends `_systemInfo` after pair-verify. Without it, a tested Apple TV answers app, account and power requests with "No request handler", so a rejected `_systemInfo` fails the connect. It then sends `TVRCSessionStart` (`ProtocolVersionKey` `1.2`): on tvOS 26.6 an Apple TV HD silently dropped power and app-list requests until it arrived (pyatv #2845). Older TVs reject it, which is ignored. The touch session's `_sessionStop` can return "Session not found" when an AirPlay/MRP connection is also open; `stopTouch()` treats that as already stopped. Verified on hardware ([tested models](https://github.com/energee/node-appletv-remote/blob/main/README.md#tested-on)).

## Connection and request lifecycle

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

## Button actions, gestures, and audio routing

These library APIs are protocol-tested; MRP button modes, touch swipes and output add/remove were exercised on hardware (#30). The CLI exposes them as `command <key> [action]`, `click`, `swipe` and `output`.

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

Button actions, touch clicks and swipes, cancellation release, and output add/remove are hardware-verified; `setOutputDevices` and UUID-correlated routing errors are not (see [Status](../README.md#status)). No hardware or stored credentials are accessed by the regression tests.

## Events

```typescript
atv.on('nowPlaying', (info) => console.log(info.toString()));  // NowPlayingInfo
atv.on('volume', (level) => {});           // 0–100; undefined when absolute volume is lost
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
connect.
