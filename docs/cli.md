# CLI reference

Every `atv` command, its arguments, and how it picks a device. `atv --help` prints the same syntax.

```bash
atv scan                          # find Apple TVs (and AirPlay receivers' psi output IDs)
atv pair                          # AirPlay pairing (enter the PIN shown on the TV)
atv companion-pair                # Companion pairing, needed for Companion-only controls/apps/accounts/power

atv command <command> [action] [deviceId]  # send one command, e.g. `atv command play`
atv command up doubleTap [deviceId]  # action: singleTap (default), doubleTap, hold
atv remote [deviceId]             # interactive remote; type `help` for commands
atv state [deviceId]              # what's playing
atv queue [deviceId]              # playback queue
atv artwork [deviceId] [out.jpg]  # save current artwork
atv messages [deviceId]           # stream raw MRP messages until Ctrl+C
atv keyboard [deviceId]           # stream keyboard/text events
atv --help                       # complete syntax and available keys

# AirPlay/MRP-only operations
atv stop [deviceId]
atv seek 120.5 [deviceId]         # absolute position in seconds (>= 0)
atv shuffle songs [deviceId]      # off, albums, songs
atv repeat all [deviceId]         # off, track, all
atv output list [deviceId]        # selected outputs, tab-separated ID and name
atv output add <psi-uuid>[,<psi-uuid>...] [deviceId]  # also remove, set

# Shared MRP/Companion controls
atv skip-forward 30 [deviceId]    # positive seconds; skip-backward also supported
atv volume 40 [deviceId]          # absolute volume, 0..100, when advertised

# Companion-only operations (requires atv companion-pair)
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

# Legacy Apple TV 2/3 (DMAP, experimental; see dmap.md)
atv dmap-pair 192.168.1.10        # this computer's LAN IPv4; enter the shown PIN on the TV
atv dmap play [deviceId]          # up down left right select menu top_menu play pause stop play_pause next previous volume_up volume_down
atv dmap state [deviceId]         # title, artist, album, play state

# Legacy RAOP audio (experimental; see audio-and-playback.md)
atv raop-stream 192.168.1.20 track.pcm  # raw PCM16LE stereo 44.1 kHz, no WAV header
```

Credentials, protocol settings, DMAP GUIDs and nonsecret endpoint hints use
`~/.atv-storage.json`, the public versioned `FileStorage` format (plaintext, mode `0600`,
not a keychain). The first run without that file validates and imports old
`~/.atv-credentials.json`, `~/.atv-dmap.json` and `~/.atv-devices.json` without deleting them.
Old HAP records without pairing-carrier provenance remain unclassified until re-pairing;
duplicate outer/Companion keys import as Companion-only. Corrupt imports reject.
Omit `deviceId` for the latest eligible record; selectors match keys/known aliases
case-insensitively, and blank, missing or ambiguous selectors reject.
Stored endpoint overrides take precedence over discovery hints. Connections try validated
cached hints first and rescan only after setup failure, before any action is sent.
Discovery matches known aliases exactly, never by a friendly-name substring.

Control commands use the public `DeviceSession` operation policy, not a separate CLI router.
Navigation/media/volume prefer eligible AirPlay MRP, enabled standalone MRP, then Companion
and supported DMAP controls; wake/suspend prefer Companion. A one-shot opens only the selected
operation's provider. `remote` opens configured credential-bearing providers and reports a clear
unavailable-operation error instead of fabricating a Companion stop/seek/queue implementation.
Text/app/account/power/click/swipe and extra buttons use only Companion. Keys remain paired
to their actual carrier; the CLI never sends standalone MRP credentials to an AirPlay endpoint.
Once an action is dispatched its error is propagated, never retried through another protocol.
`command` (alias `cmd`) accepts `skip_forward` / `skip_backward` for the provider's default;
use hyphenated commands to specify seconds. Extra buttons are `channel_up`, `channel_down`,
`screensaver`, `guide`, `page_up`, and `page_down`. Optional `singleTap`, `doubleTap`, and `hold`
actions follow supported HID/buttons; media commands, wake/suspend and `home_hold` reject
modifiers before connection. DMAP does not support hold/double-tap. Companion acceptance is
not confirmation of UI, media, volume, or power state.

Output IDs must be the receiver's AirPlay **`psi`** UUID, which `atv scan` prints as `psi=...`; its `deviceid` (MAC) and `pi` are ignored by the TV and time out after five seconds. Comma-separated IDs are trimmed and must be unique and nonblank (checked before connecting). `output add/remove/set` print the confirmed selected outputs afterward; `atv output set ""` is rejected, so the CLI cannot clear all outputs.

`atv dmap-pair` advertises this computer as a Remote on the selected local IPv4 interface,
prints a random PIN and stores the successful GUID under that device's DMAP carrier in
`~/.atv-storage.json`. Five wrong PINs, expiry or Ctrl+C close the pairing server and
unpublish the advertisement. `atv dmap` logs in with that GUID, applies DMAP endpoint
settings over cached hints and uses the same selector rules. `state` is a one-shot
snapshot; the CLI does not start DMAP push polling.

`atv raop-stream` resolves the receiver's `_raop._tcp` TXT record by browsing mDNS for up to five seconds at the given IPv4 address, then streams the file with `RaopStream`. It supports only receivers that accept unencrypted legacy PCM without a PIN (receivers requiring a legacy seed, password or HAP fail before streaming). Ctrl+C cancels and tears the session down.

Numeric values must be finite decimal numbers in the documented range. Required IDs must be nonblank. Quote text to preserve spaces; `atv text set ""` explicitly sets empty text. Invalid arguments fail before reading credentials, discovery, or connection. For one-shot commands, operation and connection failures print an error to stderr and exit nonzero; one-shot operations close their connection even on failure. Absolute volume can fail if the TV does not report its output device, and has no effect when the TV offers only relative or no volume control (see #39 in [library.md](library.md#media-results-state-and-runtime-availability)). These commands depend on device/app support and do not bypass pairing. Extra positional arguments are rejected instead of ignored. Progress (including `Requesting ...` lines from state, queue and artwork) goes to stderr so results remain clean on stdout. Empty scans and pairing cancellation/no-device selections retain their existing successful exit behavior.

Two CLI timing knobs guard HID keys, which the Apple TV never acknowledges. Set either to `0` for faster one-shot commands:

- `ATV_SETTLE_MS` (default 500): pause after the MRP handshake before sending anything, for every MRP command (a request sent before the device is ready may be dropped; for a query that would mean waiting out its 10 s timeout). Companion-only commands do not use it. The library defaults to `0`; opt in with `atv.connect(credentials, { settleMs: 500 })`.
- `ATV_POST_SEND_MS` (default 1000): pause after a one-shot key/playback/text/volume/Companion-button/click/swipe/app-launch/account-switch operation, before disconnecting. Read-only queries (`power`, `text focus`, `app list`, `account list`, `state`, `queue`, `artwork`) and `output` commands (which wait for the TV to report the new group) disconnect as soon as their reply arrives. `dmap` commands are HTTP request/response and never wait.

```
$ atv state
Big Buck Bunny by Blender Foundation [Playing] 12.50% (YouTube)
```
`atv state` deliberately keeps this concise human-readable summary. It does not
print queue content IDs, unique IDs, or store/account identifiers by default;
use the library's `NowPlayingInfo` when structured metadata is needed.


**Commands:** `command` (alias `cmd`) accepts the keys below and Companion buttons `guide`, `channel_up`, `channel_down`, `page_up`, `page_down`, and `screensaver`; see `atv --help` for complete syntax.

`up` `down` `left` `right` `select` `menu` `home` `home_hold` `top_menu` · `play` `pause` `play_pause` `next` `previous` `skip_forward` `skip_backward` · `volume_up` `volume_down` · `wake` `suspend`
