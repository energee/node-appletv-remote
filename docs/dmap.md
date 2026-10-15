# Legacy Apple TV 2/3 (DMAP, experimental)

Remote control for pre-tvOS Apple TVs over the legacy DMAP/DACP protocol.

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
