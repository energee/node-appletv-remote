# Media URL playback and audio streaming

AirPlay 2 URL playback (`AirPlayPlaybackSession`) and PCM audio streaming to AirPlay 2 and legacy RAOP receivers (`RaopStream`).

## Media URL playback (AirPlay 2)

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

### Local files

`playFile(path, position?, { address? })` opens one existing regular file and exposes it at one cryptographically random, temporary HTTP path before queuing it with the existing URL playback flow:

```typescript
const playback = new AirPlayPlaybackSession(device.address, device.port, credentials);
try {
  await playback.playFile('/media/movie.mp4', 12.5, { address: '192.168.1.20' });
  // Keep the session open while the receiver may fetch or seek the file.
} finally {
  playback.close();
}
```

The listener is bound to the supplied concrete local IPv4/IPv6 address, or by default the address selected by the OS route to the receiver. It never binds all interfaces by default. The receiver must be able to reach that LAN address. The random URL is a LAN bearer capability: do not log or share it. It serves only that opened file (not its directory) with GET/HEAD and one byte range; it does not transcode, add TLS/authentication, or make unsupported codecs playable.

The listener remains available while the receiver reports `loading`/`idle`, because that can be startup or re-fetching rather than completion. It is shut down on `close()`, playback/setup failure, listener/read errors, or a receiver-confirmed `stopped` state. If the receiver never confirms completion, the caller owns the session and must call `close()`.

Timing replies are restricted to the connected TCP peer address and, when returned by SETUP, its timing port. Only 32-byte RTP timing requests (payload type `0x52`, or `0xd2` with the marker bit) are answered, whatever their first (version) byte; the reply echoes that byte. Other 32-byte packets get no reply. UDP timing-reply send errors are ignored; timing socket failures still close the session.

HTTP errors, connection loss, malformed status, and `playbackInfo` media errors reject and close the failed session. Background heartbeat failures close the session and surface on the next `getStatus`. Requests have a five-second timeout (including URL acceptance); receivers taking longer to probe media will fail. Replies are limited to 1 MiB; duplicate Content-Length framing headers and all Transfer-Encoding responses are rejected. A rejected queue command is surfaced immediately; the authenticated SETUP sequence is not retried.

The implementation uses same-socket HAP verification, NTP/event SETUP, feedback, RECORD, then a remote-control stream SETUP (type 130) whose `/command` requests queue the item (`insertPlayQueueItem`), set the rate and ask for `playbackInfo`; the receiver pushes state on the event channel. tvOS 18+ answers the older `/play` + `/playback-info` flow with HTTP 500. Stop closes the dedicated connection; it does not send a teardown command. Tests use a synthetic loopback receiver and generated keys; hardware results are below. IPv6 receivers are supported: the timing socket binds the matching family and the Host header and RTSP URI bracket the literal. Legacy AirPlay 1, mirroring, DRM, and transcoding are not supported.

### Known limitations

**Progressive MP4 does not play on Apple TV HD (AppleTV5,3) or Apple TV 4K 1st gen (AppleTV6,2) on
tvOS 26.6 (23L773). HLS plays.** Measured on both TVs in October 2026:

- With `playFile`, the TV fetches the whole file (`Range: bytes=0-1`, then the rest) and makes the
  item current, but `playbackInfo` stays `readyToPlay: false` and the screen stays black. H.264
  Main/High with AAC-LC and faststart MP4s all behave the same, and so does `video/mp4` instead of
  `application/octet-stream`.
- With `playUrl` and a public MP4 (http or https), the TV does not fetch it. It sends the sender an
  `unhandledURL` request on the event channel (asking the sender to load the URL), which this library
  does not answer, and stays `loading`.
- Apple's HLS example stream (`img_bipbop_adv_example_fmp4/master.m3u8`) reaches `playing` on both.
- pyatv's tvOS 26 rework (robkochman `8144c77c`, from pyatv PR #2846) stalls the same way on these
  TVs; its testers report MP4 playing on Apple TV 4K (3rd gen) on tvOS 26.5 and 27.0.

Use HLS for these models. Answering `unhandledURL` by proxying the media through the sender may make
MP4 work; it is not implemented. See also #44 (seeking has no effect on tvOS 26) and #45
(unreachable URLs never report an error).

## RAOP and AirPlay 2 audio (experimental, partial #22)

`RaopStream` sends actual paced UDP audio, not a playback stub. It is a separate
one-shot API, not `AppleTV`/MRP playback. Two profiles are supported, chosen from the
receiver's TXT record: **legacy** receivers accepting unencrypted PCM/L16 over IPv4
UDP, with optional legacy PIN pair-verification, and **AirPlay 2 realtime** audio to
HAP-paired receivers (current Apple TVs), described below.
Hardware status: AirPlay 2 realtime audio, RAOP discovery and `wavPcm` are verified on the
[tested models](https://github.com/energee/node-appletv-remote/blob/main/README.md#tested-on); legacy receivers
and legacy PIN pairing are verified only against loopback tests. HomePods and other receivers needing transient pairing,
AirPlay 2 buffered audio, RSA/FairPlay/MFi authentication, password digest auth,
ALAC, multiroom, and live sources are excluded. `atv raop-stream` wraps this API
for PIN-less legacy receivers (it supplies neither a `legacySeed` nor HAP credentials). Its CLI adapter can
use an installed `ffmpeg` to decode finite files and HTTP(S) URLs; transcoding is not part of `RaopStream`.
Local `.wav` inputs also provide embedded tags, JPEG artwork, and duration; raw PCM
and remote inputs are never parsed for tags.

`extractRaopMetadata(path, explicit?)` returns `{ metadata, duration? }` for finite local
files using `music-metadata`. Explicit caller fields override extracted title, artist,
album, and artwork. Embedded artwork must be a structurally declared JPEG no larger
than 1 MiB; other or oversized covers are omitted, not converted or relabeled.
Pass the result as `RaopStream.stream(source, options)` options. Receiver `md`
capabilities gate text (`0`), artwork (`1`), and progress (`2`) before source ownership.
Initial progress and JPEG artwork are sent after SETUP and before RECORD with the
first RTP timestamp; text metadata is sent during active playback. Progress uses
rounded 44.1 kHz frame counts and wraps at 32 bits. `setMetadata()` updates text
and/or JPEG artwork during playback.

On tvOS 26.6, text/artwork/progress requests were accepted without visible metadata
display. Protocol acceptance is not proof that a receiver displays the supplied tags.

`scan()` browses `_raop._tcp` and fills `raopAddress`, `raopPort` and `raopTxt` (see
[Discovery](internals.md#discovery-and-transport-selection)). End to end, discovering a receiver and
playing a WAV file takes only library calls:

```typescript
import { createReadStream } from 'node:fs';
import { scan, RaopStream, wavPcm } from 'node-appletv-remote';

const device = (await scan({ until: d => d.name === 'Living Room' && !!d.raopPort }))
  .find(d => d.name === 'Living Room' && d.raopPort);
if (!device) throw new Error('No RAOP receiver named Living Room');

// AirPlay 2 receivers (features bit 38/48, e.g. Apple TV): { credentials } from PairSetup / atv pair.
// Legacy PIN receivers (sf 0x8/0x200): { legacySeed } from LegacyPairSetup. PIN-less legacy: {}.
const auth = { credentials };
const sender = new RaopStream(device.raopAddress!, device.raopPort!, device.raopTxt!);
await sender.stream(wavPcm(createReadStream('tone.wav')), { ...auth, volume: 50 });
```

mDNS associations are not authenticated: a spoofed advertisement can supply any
endpoint and TXT record. You can also supply an explicit endpoint and TXT record.

Legacy receivers need an IPv4 endpoint and their actual `_raop._tcp` TXT record. Required
capabilities are `cn` containing `0` (PCM), `et` containing `0` (unencrypted), `tp`
containing `UDP`, `sr=44100`, `ss=16`, and `ch=2`; `pw` must be absent or `false`.
`sf`/`flags` are parsed as hexadecimal: PIN/legacy-pairing bits `0x8`/`0x200`
require a caller-supplied `legacySeed` (from `LegacyPairSetup`, below); password bit `0x80` is unsupported. Malformed
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
ownership of the source.

**AirPlay 2 realtime audio** (audible with volume changes on the [tested models](https://github.com/energee/node-appletv-remote/blob/main/README.md#tested-on);
text metadata is accepted but nothing is shown on screen, even with the screen awake; other receivers and the details marked unverified below are untested on hardware). Pass the HAP `Credentials` that `PairSetup` (or `atv pair`) produced for
the receiver:

```typescript
const sender = new RaopStream(address, raopPort, raopTxt); // TXT with features bit 38 or 48
await sender.stream(createReadStream('track.pcm', { highWaterMark: 65536 }), { credentials, volume: 50 });
```

The sender answers NTP timing requests on its timing port from the start, because an
Apple TV queries it before replying to the base SETUP. On the same RTSP connection the
sender runs HAP pair-verify (HTTP/1.1
`/pair-verify` with `X-Apple-HKP: 3`, no CSeq), then encrypts all RTSP traffic with
the `Control-Salt` keys. A binary-plist base SETUP (`timingProtocol: NTP`, the
local timing port) returns `eventPort`; the sender connects the event channel with
`Events-Salt` keys, answers each of its requests with `200 OK`, and makes up to five
connect attempts in total, one second apart, while the connection is refused. A second
SETUP declares one realtime stream (`type: 0x60`, `ct: 1` PCM, `audioFormat: 0x800`, 352 frames per packet,
44,100 Hz, latency 11,025..88,200, a random 32-byte `shk`, and
`streamConnectionID` equal to the request-URI session id) and must return integer
`dataPort` and `controlPort` values in 1..65535. There is no ANNOUNCE or Transport
header. The `Session` header from that reply is used when present (validated like
legacy); otherwise `Session: 0` is sent, as receivers of this profile may omit it.
RECORD and FLUSH (with `RTP-Info`) follow. `POST /feedback` is sent once FLUSH (and any
initial volume/metadata) has been answered, then every two seconds, best effort (failures
are logged, at most one in flight). The reference sends the first feedback right after
RECORD without waiting for replies; this sender's RTSP requests are strictly serialized,
so putting feedback first would hold RECORD for up to 5 s on a receiver that ignores it.
The same serialization means an unanswered feedback request can delay `setVolume` or
`setMetadata` by up to 5 s. RECORD carries `Range: npt=0-` and FLUSH does not, as in the
legacy profile (the reference does the reverse; unverified which a receiver needs). A
receiver-chosen `Audio-Latency` on RECORD is accepted while the fixed 66,150-frame
send schedule is kept. Every audio packet is sealed with ChaCha20-Poly1305 using
`shk`, a per-stream 64-bit counter nonce and the RTP timestamp and SSRC as AAD; the
packet carries the 12-byte RTP header, ciphertext, tag and the counter's 8 bytes.
Resends repeat the stored sealed packet. Sync, timing, volume, text metadata,
cancellation and source handling are the same as legacy. Losing the event channel
(close, error, or a request the responder cannot decrypt or parse) fails the stream;
the reference instead logs per-message failures and ignores the channel closing, so
this is stricter and unverified on hardware. Teardown sends TEARDOWN, then closes the
RTSP and event connections and zeroes `shk`. Other key material is zeroed too: the
pair-verify shared secret and the plaintext stream SETUP body (which carries `shk`) as
soon as setup has used them, and the RTSP and event-channel session keys when their
connections close (also on setup failure).

```typescript
import { createReadStream } from 'node:fs';
import { RaopStream } from 'node-appletv-remote';

// address, raopPort and raopTxt come from scan() (device.raopAddress/raopPort/raopTxt).
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
left/right**, with no WAV header (use `wavPcm`, below, for WAV files). Total length
must be divisible by four. Keep
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
uses a fixed 66,150-frame latency (1.5 seconds). For legacy receivers other returned
`Audio-Latency` values are rejected rather than silently assumed compatible.

**WAV input.** `wavPcm(readable)` reads a RIFF/WAVE file and yields its `data` payload
as a `RaopPcmSource` (Buffers of at most 65,536 bytes). Only PCM16 (format 1) stereo
44.1 kHz WAV is accepted; any other `fmt ` throws
`Unsupported WAV: requires PCM16 stereo 44100 Hz`, and a malformed header, a `data`
chunk before `fmt `, or a file that ends before the declared data length throws an
`Invalid WAV` error. Other chunks (such as `LIST`) are skipped, honoring odd-size pad
bytes, and nothing after `data` is read. The Readable is destroyed when iteration
ends. Other formats need converting first (for example with ffmpeg); this library
does not transcode. The `atv raop-stream` CLI performs that conversion for finite local files,
incompatible WAV files, and HTTP(S) URLs when `ffmpeg` is installed; see [the CLI reference](cli.md).

```typescript
import { createReadStream } from 'node:fs';
import { RaopStream, wavPcm } from 'node-appletv-remote';

await new RaopStream(address, raopPort, raopTxt).stream(wavPcm(createReadStream('tone.wav')), { volume: 50 });
```

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

Legacy keepalive probes `POST /feedback` once before audio (AirPlay 2 uses the
two-second cadence above instead). Only a 200 response
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
from prior **legacy AirPlay PIN pairing** (`LegacyPairSetup`); HAP `Credentials`, HAP `clientLTSK` and
DMAP GUIDs are not interchangeable. No key/credential files are read automatically.
This legacy exchange proves the client's paired key to the
receiver, does not verify a receiver identity, and enables no transport encryption;
use only on a trusted LAN. Tests use synthetic keys, a verifying loopback peer,
and independent public legacy verification byte vectors.

**Legacy PIN pairing** produces that seed once per receiver. `start()` makes the receiver
show a PIN; `finish(pin)` runs the three `/pair-setup-pin` steps (SRP-6a, RFC 5054 2048-bit
group, SHA-1, username = client id, password = PIN; then the client's new Ed25519 public key,
AES-128-GCM encrypted under the SRP session key) and returns `{ clientId, seed }`:

```typescript
import { LegacyPairSetup, RaopStream } from 'node-appletv-remote';

const pairing = new LegacyPairSetup(device.raopAddress!, device.raopPort!);
await pairing.start();                          // the receiver displays a PIN
const { clientId, seed } = await pairing.finish(pinFromUser);
// Persist clientId and seed yourself; the seed is a secret, like a password.

await new RaopStream(device.raopAddress!, device.raopPort!, device.raopTxt!)
  .stream(source, { legacySeed: seed });
```

A wrong PIN rejects with `Legacy pair-setup failed: wrong PIN or receiver rejected the
proof (HTTP <status>)`, and a receiver proof that does not match rejects too; the HTTP
connection is closed when `finish()` settles. The pairing requests go out without
`X-Apple-HKP` (that header selects HAP pairing instead). Pairing authenticates the PIN
holder to the receiver, but later legacy pair-verify still authenticates only the client
and encrypts nothing, so the trusted-LAN caveat above applies. Tests use a loopback
receiver built on fast-srp-hap's `SrpServer` and fixed SRP vectors with leading-zero `A`
and `S`; **legacy PIN pairing is unverified on hardware** (hardware check H3).

The RTSP control client also sends `/pair-pin-start` and `/pair-setup` as CSeq-less
HTTP/1.1 requests; transient pairing for HomePods will use them and is not
implemented yet. Physical interoperability of both profiles remains unverified.

**Teardown on Apple TV:** an Apple TV closes the AirPlay 2 event channel while handling TEARDOWN, so the TEARDOWN reply is not read; teardown is best effort and the stream still completes.
