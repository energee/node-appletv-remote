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

# AirPlay/MRP only
atv remote [deviceId]             # interactive remote
atv stop [deviceId]
atv seek 120.5 [deviceId]         # absolute position in seconds (>= 0)
atv shuffle songs [deviceId]      # off, albums, songs
atv repeat all [deviceId]         # off, track, all
atv output list [deviceId]        # selected outputs, tab-separated ID and name
atv output add <psi-uuid>[,<psi-uuid>...] [deviceId]  # also remove, set

# Companion only (requires atv companion-pair)
atv skip-forward 30 [deviceId]    # positive seconds; skip-backward also supported
atv volume 40 [deviceId]          # absolute volume, 0..100, when advertised
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

Credentials are saved to `~/.atv-credentials.json`. Leave out `deviceId` to use the most recently paired device. An explicit selector matches a paired device ID case-insensitively; blank or unmatched selectors fail instead of silently selecting the last device. Each device's last working address is cached in `~/.atv-devices.json`, so commands skip the network scan. If the TV has moved, the CLI rescans automatically; an address that silently drops packets fails over after a 5 s connect timeout rather than the OS TCP timeout (about 75 s on macOS).

One-shot `command` uses Companion for navigation (except `top_menu`/`home_hold`), media, volume buttons, wake, and suspend; `skip-forward`, `skip-backward`, and `volume` are also Companion-only. The interactive `remote` remains MRP-only. Text/app/account/power/click/swipe commands and extra buttons open only Companion. `command` (alias `cmd`) accepts `skip_forward` / `skip_backward` for Companion's default 10-second interval; use the hyphenated commands to specify seconds. Extra Companion buttons are `channel_up`, `channel_down`, `screensaver`, `guide`, `page_up`, and `page_down` (not available in the MRP-only interactive remote). An optional action (`singleTap`, `doubleTap`, `hold`; case-insensitive) may follow navigation/HID keys and Companion buttons; media keys, `wake`, `suspend`, skips and `home_hold` reject it before connecting. A successful Companion command is accepted by the TV, not confirmation of UI, media, volume, or power state.

Output IDs must be the receiver's AirPlay **`psi`** UUID, which `atv scan` prints as `psi=...`; its `deviceid` (MAC) and `pi` are ignored by the TV and time out after five seconds. Comma-separated IDs are trimmed and must be unique and nonblank (checked before connecting). `output add/remove/set` print the confirmed selected outputs afterward; `atv output set ""` is rejected, so the CLI cannot clear all outputs.

`atv dmap-pair` advertises this computer as a Remote on the given local IPv4 interface, prints a random PIN, waits up to five minutes for the TV, and stores the pairing GUID in `~/.atv-dmap.json` (separate from modern credentials, keyed by the device ID shown in the selection list: the AirPlay `deviceid` when the TV also advertises AirPlay on that address, which Apple TV 2/3 normally do, otherwise `dmap:<instance>`). It fails immediately once five wrong PINs lock pairing or the window expires; Ctrl+C cancels, closes the callback server and unpublishes the advertisement. `atv dmap` logs in with that GUID; `[deviceId]` selects among DMAP pairings the same way. Its address is cached like the others. `state` is a one-shot snapshot; the CLI does not use the library's DMAP push updates.

`atv raop-stream` resolves the receiver's `_raop._tcp` TXT record by browsing mDNS for up to five seconds at the given IPv4 address, then streams the file with `RaopStream`. It supports only receivers that accept unencrypted legacy PCM without a PIN (receivers requiring a legacy seed, password or HAP fail before streaming). Ctrl+C cancels and tears the session down.

Numeric values must be finite decimal numbers in the documented range. Required IDs must be nonblank. Quote text to preserve spaces; `atv text set ""` explicitly sets empty text. Invalid arguments fail before reading credentials, discovery, or connection. For one-shot commands, operation and connection failures print an error to stderr and exit nonzero; one-shot operations close their connection even on failure. Absolute volume can fail if the TV does not report its output device, and has no effect when the TV offers only relative or no volume control (see #39 in [library.md](library.md#media-results-state-and-runtime-availability)). These commands depend on device/app support and do not bypass pairing. Extra positional arguments are rejected instead of ignored. Progress (including `Requesting ...` lines from state, queue and artwork) goes to stderr so results remain clean on stdout. Empty scans and pairing cancellation/no-device selections retain their existing successful exit behavior.

Two CLI timing knobs guard HID keys, which the Apple TV never acknowledges. Set either to `0` for faster one-shot commands:

- `ATV_SETTLE_MS` (default 500): pause after the MRP handshake before sending anything, for every MRP command (a request sent before the device is ready may be dropped; for a query that would mean waiting out its 10 s timeout). Companion-only commands do not use it. The library defaults to `0`; opt in with `atv.connect(credentials, { settleMs: 500 })`.
- `ATV_POST_SEND_MS` (default 1000): pause after a one-shot key/playback/text/volume/Companion-button/click/swipe/app-launch/account-switch operation, before disconnecting. Read-only queries (`power`, `text focus`, `app list`, `account list`, `state`, `queue`, `artwork`) and `output` commands (which wait for the TV to report the new group) disconnect as soon as their reply arrives. `dmap` commands are HTTP request/response and never wait.

```
$ atv state
Big Buck Bunny by Blender Foundation [Playing] 12.50% (YouTube)
```

**Commands:** `command` (alias `cmd`) accepts the keys below and Companion buttons `guide`, `channel_up`, `channel_down`, `page_up`, `page_down`, and `screensaver`; see `atv --help` for complete syntax.

`up` `down` `left` `right` `select` `menu` `home` `home_hold` `top_menu` · `play` `pause` `play_pause` `next` `previous` `skip_forward` `skip_backward` · `volume_up` `volume_down` · `wake` `suspend`
