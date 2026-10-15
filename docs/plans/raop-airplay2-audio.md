# Plan: remaining RAOP / AirPlay 2 audio work (#22)

Status: **plan only, awaiting approval.** No implementation code is part of this change.

## Where we are

Already on `main` (PR #27, `src/raop/*`, README "Legacy RAOP audio"):

- `RaopStream(address, port, txt)` streams finite PCM16LE stereo 44.1 kHz as big-endian L16
  over UDP to **legacy** receivers (`cn=0`, `et=0`, `tp=UDP`), with paced packets, 1 s sync,
  NTP timing replies, a 1,000-packet resend history, volume, text metadata, feedback and
  bounded teardown.
- Optional legacy pair-verify when the caller supplies a 32-byte `legacySeed`.
- The constructor **fails closed** on modern advertisements (`ft`/`features` bits 38, 40, 43, 48),
  so it cannot reach current Apple TVs or HomePods.
- No hardware verification has been done.

Reusable pieces that the work below must build on rather than copy:

| Need | Existing code |
| --- | --- |
| HAP pair-verify returning `{ outputKey, inputKey, sharedSecret }` over an injected `post` transport | `src/auth/pair-verify.ts` (`PairVerify`) |
| HAP pair-setup (PIN) and SRP-6a (3072-bit, SHA-512) | `src/auth/pair-setup.ts`, `src/auth/srp.ts` |
| Encrypted RTSP/HTTP framing on a socket | `src/util/hap-session.ts` (`HAPSession.encrypt` / `decryptAvailable`) |
| ChaCha20-Poly1305 with 12-byte counter nonce (4 zero bytes + 64-bit LE counter) | `src/util/crypto.ts` (`encryptChaCha20`, `generateNonce`, `hkdfSha512`) |
| HTTP message framing | `src/connection.ts` (`parseHTTPMessage`, `connectSocket`, `hostForURL`) |
| Binary plist encode/decode, `Real` wrapper | `bplist-creator`, `bplist-parser` as used in `src/airplay-playback.ts` |
| AirPlay 2 base SETUP + encrypted event channel (`Events-Salt`) | `src/airplay-playback.ts` (inline, being edited by open PR #43) |
| RTP audio / sync / timing / resend packets | `src/raop/packets.ts` |
| DMAP tag encoding for metadata | `src/dmap/codec.ts` (`encodeDmap`) |
| mDNS browse and identity grouping | `src/discovery.ts` (`scan`) |

## What the upstream reference implementation does (protocol evidence)

Read from the upstream reference implementation's `protocols/raop/*` and `protocols/airplay/*`
(treated as data, not copied):

- **Protocol choice:** AirPlay 2 when `features` has bit 38 (unified media control) or bit 48
  (CoreUtils pairing and encryption); otherwise AirPlay 1 (legacy RAOP). Credentials: stored
  credentials if given, else *transient* pairing when bit 43 (system pairing) or 48 is set,
  else none. Receivers with bit 40 (buffered audio) or 43 (system pairing) but neither 38 nor 48
  are treated as AirPlay 1.
- **AirPlay 2 realtime audio flow:** pair-verify on the RTSP socket, then `Control-Salt`
  keys encrypt the RTSP connection; `SETUP` with a base bplist (`timingProtocol: NTP`,
  `timingPort`, device/session identity) returns `eventPort`; connect the event channel with
  `Events-Salt` keys and answer its requests; second `SETUP` with
  `streams: [{ type: 0x60, ct: 1, audioFormat: 0x800, spf: 352, sr: 44100, latencyMin: 11025,
  latencyMax: 88200, shk: <32-byte key>, controlPort, isMedia: true, audioMode: 'default',
  supportsDynamicStreamID: false, streamConnectionID: <RTSP session id> }]` (the session id is
  the number in the request URI `rtsp://<local ip>/<id>`) returns `dataPort` and `controlPort`;
  feedback every 2 s; `RECORD`; `FLUSH` with `RTP-Info`; then the same paced
  RTP/sync/timing/resend loop as legacy. The event-channel connect is retried up to 5 times,
  1 s apart, on connection refused, because some receivers open the event port only after
  answering SETUP. The reference never reads a `Session` header in this profile and sends
  `Session: 0` on FLUSH/TEARDOWN.
- **Per-packet encryption (AirPlay 2 realtime):** ChaCha20-Poly1305 with key `shk`;
  nonce = 4 zero bytes + 64-bit LE counter incremented per packet; AAD = RTP header bytes 4..11
  (timestamp + SSRC); wire packet = 12-byte RTP header + ciphertext + 16-byte tag + the last
  8 bytes of the nonce. Resends retransmit the stored sealed packet. Samples are the same
  byte-swapped (big-endian) PCM16 as legacy L16.
- **Transient pairing (HomePods):** on the RTSP connection itself (HTTP/1.1 framing, no CSeq,
  header `X-Apple-HKP: 4`): `POST /pair-pin-start`, then `POST /pair-setup` M1 with
  `Flags = 0x10` (transient), M3 with the fixed PIN `3939`; stop after M4 and derive the
  `Control-Salt` / `Events-Salt` keys from the SRP shared key K with HKDF. The `Control-Salt`
  keys then encrypt that same RTSP connection. (Stored-credential HAP pair-verify uses
  `X-Apple-HKP: 3`.)
- **Legacy PIN pair-setup:** `POST /pair-pin-start`, then three binary-plist `POST
  /pair-setup-pin` steps: `{ method: 'pin', user: <client id hex> }` → `{ pk, salt }`;
  `{ pk: A, proof: M1 }`; `{ epk, authTag }` where `epk`/`authTag` are AES-128-GCM of the client
  Ed25519 public key with key `SHA512("Pair-Setup-AES-Key" || K)[0:16]` and IV
  `SHA512("Pair-Setup-AES-IV" || K)[0:16]` with the last byte incremented. SRP uses the 2048-bit
  group, SHA-1, username = client id, password = PIN, and an Apple-specific session key
  `K = SHA1(S || 00000000) || SHA1(S || 00000001)`. `fast-srp-hap` already computes exactly this
  K whenever the params hash is `sha1` (its `SRP.params[2048]` group; checked by comparing
  `computeK()` with the formula). The resulting 32-byte seed is exactly the existing `legacySeed`.
- **Metadata:** `md` TXT lists `0` text, `1` artwork, `2` progress. Artwork is
  `SET_PARAMETER` with `Content-Type: image/jpeg` (always JPEG) and `RTP-Info`; progress is
  `SET_PARAMETER text/parameters` body `progress: <start>/<now>/<end>` in RTP time with
  `start = now = ` the first packet's RTP time and `end = start + duration * 44100`. The
  reference sends progress, text and artwork after SETUP and **before** `RECORD`. (This library
  currently sends text metadata after `FLUSH`; that ordering is unverified on hardware.)
- **Decoding:** the reference uses a native audio library to decode files and resample.
  Formats other than raw PCM are a sender-side concern; receivers only see PCM (or ALAC).
- **ALAC:** the reference sends L16 only for both protocols. Buffered AirPlay 2 audio
  (`type: 103`) is not implemented there either.

## Decisions

1. **One public class.** Extend `RaopStream` with an AirPlay 2 realtime profile chosen from the
   TXT record instead of adding a second stream class. The packet pacing, source handling,
   sync, timing, resend, volume and metadata code is identical; only auth, SETUP and packet
   sealing differ. New AirPlay 2 setup lives in `src/raop/airplay2.ts` so `stream.ts` does
   not grow a second negotiation inline.
2. **Credentials:** AirPlay 2 uses the existing HAP `Credentials` from `PairSetup` (the same
   ones `atv pair` stores). Transient pairing is added later for HomePods. `legacySeed` stays
   legacy-only.
3. **File decoding:** no npm decoder dependency. The library gains a tiny WAV (RIFF PCM16
   44.1 kHz stereo) reader. Every other format (MP3, FLAC, OGG, AAC, other WAV rates) is handled
   in the CLI by piping through `ffmpeg -f s16le -ar 44100 -ac 2` when it is on `PATH`, with a
   clear error when it is not. Rationale: decoder packages are large, often native/WASM, and
   resampling would also be needed; ffmpeg already does all of it.
4. **ALAC:** deferred and evidence-gated. Only built (as uncompressed "verbatim" ALAC frames)
   if a real receiver is found that rejects L16. Buffered AirPlay 2 audio is out of scope
   (spike only).
5. **Event channel:** the encrypted event-channel responder becomes one helper in
   `src/util/event-channel.ts`, used by AirPlay 2 audio immediately and by
   `airplay-playback.ts` once PR #43 has merged (to avoid a conflict with that live branch).

## Recommended minimal first deliverable

**Phase 1 only: AirPlay 2 realtime PCM to an Apple TV that is already HAP-paired**
(tasks 1–6, then hardware check 7). It reaches the receivers people actually own, reuses the
existing credentials and nearly all of the legacy loop, and needs no new dependencies,
discovery changes or pairing UI. Callers pass the `_raop._tcp` (or `_airplay._tcp`) endpoint
and TXT as they do today, plus `credentials`.

## Tasks

Each task starts by writing the named failing test, running it red, then implementing.
Every task's acceptance includes `pnpm exec tsc --noEmit`, `pnpm exec vitest run` and
`pnpm run build` passing, README/JSDoc updated in the same commit, and no new mention of the
upstream project name.

### Phase 1 — AirPlay 2 realtime PCM (minimal first deliverable)

**1. Sealed AirPlay 2 audio packets**
- Files: `src/raop/packets.ts`
- Types: `export function sealAudioPacket(packet: Buffer, key: Buffer, counter: bigint): Buffer`
  (input is an `audioPacket()` result; output is header + ciphertext + tag + 8-byte LE counter).
- Test first: `src/raop/__tests__/packets.test.ts` (new `describe('sealAudioPacket')`):
  decrypt with `node:crypto` `chacha20-poly1305` using an independently built nonce and
  AAD = bytes 4..11; header bytes unchanged; trailer equals the counter; tampering the
  header fails authentication; `PacketHistory.resend` returns the sealed bytes unchanged.
- Reuse: `encryptChaCha20`, `generateNonce`.
- Depends on: none. Parallel with 2, 3, 8, 9, 10.

**2. Encrypted RTSP control client**
- Files: `src/raop/stream.ts` (`RtspClient` gains encryption; exported for tests only, not from
  `src/index.ts`).
- Types: `RtspClient.encryptWith(session: HAPSession): void` — after it is called every write
  is `session.encrypt(...)` and reads go through `session.decryptAvailable` before
  `parseHTTPMessage`. HTTP/1.1 framing without CSeq (today only `POST /pair-verify`) is extended
  to `POST /pair-pin-start` and `POST /pair-setup` so transient pairing (task 12) runs on the
  same socket. Callers pass `X-Apple-HKP` (`3` for HAP pair-verify, `4` for transient) through
  the existing `headers` argument.
- Test first: `src/raop/__tests__/rtsp-client.test.ts`: loopback server with a mirror
  `HAPSession`; encrypted request/response round trip with CSeq correlation; a response split
  across TCP chunks and across 1,024-byte frames; authentication failure fails the client;
  `POST /pair-setup` and `/pair-pin-start` go out as `HTTP/1.1` without `CSeq`.
- Depends on: none. Parallel with 1, 3.

**3. Profile classification from TXT**
- Files: `src/raop/stream.ts` (constructor).
- Types: private `readonly profile: 'legacy' | 'airplay2'`; `RaopStreamOptions.credentials?:
  HAPCredentials`.
- Behavior: bit 38 or 48 selects `airplay2` (no longer a constructor error). Everything
  legacy-only applies only to `legacy`: the `cn`, `et`, `tp`, `sr/ss/ch` checks **and** the
  `sf`/`flags` `0x8`/`0x200` rule that sets `requiresLegacySeed` (real Apple TVs advertise
  `flags=0x244`, which includes `0x200`; applying the rule to `airplay2` would reject every
  Apple TV). Password bit `0x80`, `pw=true`, `act=2` and `acl=1` still fail closed for both.
  Bit 40 or 43 without 38 or 48 keeps failing closed in the constructor, as today: the
  reference would try AirPlay 1 there, but legacy setup cannot handle buffered-only or
  system-paired receivers, so relaxing this waits for hardware evidence. `stream()` rejects
  `airplay2` without `credentials`, `credentials` on `legacy`, and `legacySeed` on `airplay2`,
  all before taking source ownership.
- Test first: update `src/raop/__tests__/stream.test.ts` case "requires legacy material for
  PIN flags and refuses modern audio/auth advertisements" into explicit cases for each rule,
  including: features with bit 48 plus `flags=0x244` and `credentials` (no `legacySeed`) is
  accepted; the same TXT without bit 38/48 still requires `legacySeed`; bit 40 alone and bit
  43 alone are rejected by the constructor.
- Depends on: none. Parallel with 1, 2.

**4. Shared encrypted event-channel responder**
- Files: new `src/util/event-channel.ts` (module comment), test
  `src/util/__tests__/event-channel.test.ts`.
- Types: `export async function openEventChannel(host: string, port: number, sharedSecret:
  Buffer, onError: (error: Error) => void, signal?: AbortSignal): Promise<Socket>` — connects
  with `Events-Salt` read/write keys and answers each RTSP/HTTP request with `200 OK`
  (echoing `CSeq`), exactly as `airplay-playback.ts` does today. On `ECONNREFUSED` it retries
  up to 5 attempts in total, 1 s apart (abortable); other errors and the fifth refusal reject.
- Test first: loopback receiver sends two encrypted requests in one chunk and one split
  request; each gets one encrypted 200 with matching CSeq; a bad tag calls `onError`; abort
  destroys the socket; a port that starts listening after the first refused attempt connects
  on retry (fake timers); five refusals reject; abort during the retry wait rejects without
  another attempt.
- Depends on: none. Parallel with 1–3.

**5. AirPlay 2 audio SETUP sequence**
- Files: new `src/raop/airplay2.ts` (module comment).
- Types:
  ```ts
  export interface AirPlay2Audio { serverPort: number; controlPort: number; audioKey: Buffer; events: Socket }
  export async function setupAirPlay2Audio(client: RtspClient, host: string, credentials: HAPCredentials,
    sessionId: number, localPorts: { timing: number; control: number }, signal: AbortSignal): Promise<AirPlay2Audio>
  ```
  Runs `PairVerify` through `client` (HTTP `/pair-verify`, `X-Apple-HKP: 3`) via an inline
  `{ post, destroy }` object over `client.request` (no new adapter class), calls
  `client.encryptWith`, sends the base SETUP bplist, opens the event channel (task 4), sends the
  stream SETUP bplist with a random 32-byte `shk`, `supportsDynamicStreamID: false` and
  `streamConnectionID: sessionId` (the same number passed to `client.setLocalUri`), validates
  `dataPort`/`controlPort` as integers 1..65535, and returns them. Task 12 later widens
  `credentials` to optional (transient pairing); nothing else changes in this signature.
- Test first: `src/raop/__tests__/airplay2.test.ts`: loopback receiver that performs HAP
  pair-verify (pattern from `src/__tests__/airplay-playback.test.ts`), decodes both SETUP
  bodies with `bplist-parser` and asserts the fields listed above (`type 0x60`, `ct 1`,
  `audioFormat 0x800`, `spf 352`, `sr 44100`, `timingProtocol 'NTP'`, 32-byte `shk`,
  `supportsDynamicStreamID false`, `streamConnectionID` equal to the request-URI session id);
  missing or invalid ports reject; wrong credentials reject; abort during event connect
  cleans up.
- Depends on: 2, 4.

**6. Stream AirPlay 2 realtime audio through `RaopStream`**
- Files: `src/raop/stream.ts`, `src/index.ts` (export unchanged names; JSDoc), `README.md`
  (rename section to "RAOP and AirPlay 2 audio (experimental, partial #22)").
- Behavior for `airplay2`: no ANNOUNCE/Transport SETUP; `setupAirPlay2Audio` instead; `RECORD`,
  `FLUSH` with `RTP-Info`; feedback every 2 s, best effort; every audio packet sealed with a
  per-stream counter before `history.add`; sync/timing/resend/volume/metadata unchanged;
  TEARDOWN then destroy the event socket and zero `audioKey`. `this.session` comes from the
  stream SETUP response's `Session` header when present (validated as in legacy), otherwise
  `'0'` as the reference sends; it is never left undefined, so TEARDOWN, `setVolume` and
  `setMetadata` always carry a `Session` header (unverified on hardware). The fixed 66,150-frame latency
  is kept; a different `Audio-Latency` on RECORD is accepted for `airplay2` (receiver-chosen)
  and documented as unverified.
- Test first: `src/raop/__tests__/airplay2-stream.test.ts`: loopback receiver decrypts every
  UDP audio packet with `shk` and reassembles exactly the source PCM in big-endian order plus
  the silence tail; counter increments by one per packet; a resend request returns
  byte-identical sealed packets; feedback cadence 2 s under the controlled clock;
  cancellation and source errors close RTSP, event and UDP sockets; with no `Session` header
  in either SETUP response, RECORD/FLUSH/SET_PARAMETER/TEARDOWN carry `Session: 0` and
  TEARDOWN is sent; with one, that value is used.
- Depends on: 1, 2, 3, 5.

**7. Hardware check H1 (needs hardware)**
- Device: Apple TV 4K paired with `atv pair` (HAP credentials).
- Procedure (operator-run, nothing committed except the outcome in the PR and README status):
  stream a 10 s 440 Hz tone (`ffmpeg -f lavfi -i sine=f=440:d=10 -f s16le -ar 44100 -ac 2 tone.pcm`)
  through a short `node --input-type=module` snippet using `RaopStream`; confirm audible playback,
  `setVolume` effect, text metadata on screen, clean return to idle after TEARDOWN, and no
  receiver error in sanitized logs.
- Depends on: 6. If it fails, the result is captured and Phase 1 stays experimental.

### Phase 2 — Inputs, discovery and legacy pairing

**8. WAV input**
- Files: new `src/raop/wav.ts` (module comment), `src/index.ts`, `README.md`.
- Types: `export function wavPcm(source: Readable): AsyncIterable<Buffer>` — validates the
  RIFF/WAVE `fmt ` chunk (PCM format 1, 2 channels, 44,100 Hz, 16 bits), skips other chunks,
  yields the `data` chunk in Buffers of at most 65,536 bytes; anything else throws
  `'Unsupported WAV: requires PCM16 stereo 44100 Hz'`.
- Test first: `src/raop/__tests__/wav.test.ts` with hand-built headers: extra `LIST` chunk
  before `data`, header split across reads, odd-sized chunk padding, wrong rate/channels/format
  rejected, truncated header rejected.
- Depends on: none. Parallel with everything in Phase 1.

**9. `_raop._tcp` discovery and endpoint selection**
- Files: `src/discovery.ts`, `README.md` (Discovery section and audio example).
- Types: add to `DiscoveredDeviceInfo` and `DiscoveredDevice`: `raopPort?: number`,
  `raopAddress?: string`, `raopTxt?: Readonly<Record<string, string>>`.
- Behavior: browse `raop`; the instance name is `<MAC hex>@<name>`; join the record to the
  AirPlay group whose `deviceid` MAC matches (colon-insensitive); RAOP-only receivers become
  their own devices named after the part after `@`. Usage becomes
  `new RaopStream(device.raopAddress!, device.raopPort!, device.raopTxt!)`; no new selection
  helper (the profile choice already lives in task 3).
- Test first: `src/__tests__/discovery.test.ts` (existing bonjour mock): joins by MAC,
  keeps a RAOP-only receiver, ignores a malformed instance name, TXT keys lower-cased.
- Depends on: none. Parallel.

**10. Legacy SRP compatibility check (no new SRP code)**
- Files: none in `src`; task 11 calls `fast-srp-hap`'s `SrpClient` directly with
  `SRP.params[2048]` (SHA-1, which already yields the Apple 40-byte interleaved K), username =
  client id, password = PIN. No wrapper class: it would have one caller.
- Test first: `src/auth/__tests__/legacy-srp.test.ts` with fixed vectors (salt, B, a, PIN,
  username → A, M1, K) generated once by an independent SRP implementation and stored as hex,
  asserting `SrpClient` reproduces them. If M1 differs (e.g. padding), task 11 computes M1
  inline from `SrpClient`'s A, B and K; still no second SRP implementation.
- Depends on: none. Parallel.

**11. Legacy PIN pair-setup (`legacySeed` without manual material)**
- Files: new `src/auth/legacy-pair-setup.ts` (module comment), `src/index.ts`, `README.md`.
- Types:
  ```ts
  export interface LegacyAirPlayCredentials { clientId: string; seed: Buffer }
  export class LegacyPairSetup {
    constructor(host: string, port: number, transport?: Pick<PersistentHttp, 'post' | 'destroy'>);
    start(): Promise<void>;                       // POST /pair-pin-start
    finish(pin: string): Promise<LegacyAirPlayCredentials>; // three /pair-setup-pin bplist steps
  }
  ```
  `clientId` is 16 upper-case hex characters; `seed` is a fresh 32-byte Ed25519 seed and is what
  `stream(source, { legacySeed })` accepts.
- Test first: `src/auth/__tests__/legacy-pair-setup.test.ts`: loopback receiver checks the
  three plist bodies, verifies the SRP proof with fast-srp-hap's `SrpServer` (2048-bit, SHA-1), decrypts `epk` with AES-128-GCM
  (key/IV derivation above, IV last byte + 1) and matches it to the seed's public key; the
  resulting seed then passes the existing legacy pair-verify loopback in `stream.test.ts`.
  Wrong PIN rejects with a clear error.
- Depends on: 10.

### Phase 3 — HomePods, metadata and CLI

**12. Transient pairing (HomePods and system-paired receivers)**
- Files: new `src/auth/transient-pair.ts` (module comment), `src/raop/airplay2.ts`,
  `src/raop/stream.ts` (credential check in `stream()`), `README.md`.
- Types: `export async function transientVerify(client: RtspClient, signal: AbortSignal): Promise<{ outputKey: Buffer; inputKey: Buffer; sharedSecret: Buffer }>`
  — same shape as `PairVerify.verify()`. Runs on the RTSP connection (not `PersistentHttp`,
  which is a separate socket and sends `X-Apple-HKP: 3`): `POST /pair-pin-start`, then
  `/pair-setup` M1 with `Flags = 0x10` and M3 with PIN `3939` via `SRPClient`, all with
  `X-Apple-HKP: 4`; stops after M4; derives `Control-Salt` keys (and returns K as
  `sharedSecret` for `Events-Salt`) with `hkdfSha512`. `setupAirPlay2Audio`'s `credentials`
  becomes optional: present → `PairVerify`, absent → `transientVerify`; both then call
  `client.encryptWith` on the same connection.
- Behavior: `airplay2` with no `credentials` and bit 43 or 48 uses transient pairing;
  otherwise `stream()` still rejects missing credentials before taking ownership.
- Test first: `src/auth/__tests__/transient-pair.test.ts` using a loopback RTSP receiver with
  fast-srp-hap's `SrpServer`: request order `/pair-pin-start`, `/pair-setup`, `/pair-setup`;
  each is HTTP/1.1 with `X-Apple-HKP: 4` on the one socket; `Flags` TLV present; keys match an
  independent HKDF over the server's K; the following SETUP arrives encrypted with them on the
  same socket; server error TLV rejects. Plus a `stream.test.ts` case for the credential rule.
- Depends on: 6 (edits `stream.ts` and the `setupAirPlay2Audio` signature; run after 6 and
  sequentially with 13).

**13. Artwork and progress metadata**
- Files: `src/raop/stream.ts`, `README.md`.
- Types: `RaopMetadata.artwork?: Buffer` (JPEG only: must start with `FF D8 FF`; at most
  1 MiB; sent as `image/jpeg` like the reference); `RaopStreamOptions.duration?: number`
  (seconds; enables progress). No separate `setArtwork()`: artwork goes through the existing
  `metadata` option and `setMetadata()`.
- Behavior: artwork requires `md` containing `1`, progress requires `md` containing `2`
  (otherwise reject before ownership). As in the reference, progress
  (`start = now = ` first packet RTP time, `end = start + duration * 44100`) and initial
  artwork are sent after SETUP and before `RECORD`. Text metadata keeps its current
  after-`FLUSH` placement; the divergence from the reference is documented as unverified and
  H4 decides whether text moves too.
- Test first: additions in `src/raop/__tests__/stream.test.ts` (legacy) and
  `src/raop/__tests__/airplay2-stream.test.ts` (encrypted): request order (progress/artwork
  before RECORD), headers, bodies, gating, non-JPEG rejected, size cap.
- Depends on: 6 (same file; run after it, sequentially with 12).

**14. CLI audio streaming integration**
- Files: `src/cli/index.ts`, `src/__tests__/cli.test.ts`, `README.md` (CLI section).
- Behavior: builds on the basic PCM stream command being added by the separate CLI track.
  Inputs: `.pcm` as-is, `.wav` via task 8, anything else via `ffmpeg` child process (missing
  ffmpeg → error naming the WAV/PCM alternatives). Endpoint from task 9; HAP credentials from
  the existing device cache for `airplay2`; `--legacy-seed <file>` for legacy; `--volume`.
- Test first: `src/__tests__/cli.test.ts` with mocked `child_process.spawn` and a mocked
  `RaopStream`: argument validation, ffmpeg argv, ffmpeg-missing message, exit code on stream
  failure, SIGINT aborts the stream.
- Depends on: 6, 8, 9 and the CLI track's merged stream command.

**15. Move `airplay-playback.ts` onto the shared event-channel helper**
- Files: `src/airplay-playback.ts`, `README.md` (if the retry is user-visible there).
- Test first: `src/__tests__/airplay-playback.test.ts` gains a case where the event port
  refuses the first connect and accepts on retry; playback must still succeed. This is red
  before the move (today's code connects once) and green after it (task 4 retries). The
  existing CSeq echo assertion (line 32) already guards reply behavior and stays green.
- Depends on: 4 and PR #43 merged (it rewrites this file).

**16. Hardware checks H2–H4 (needs hardware)**
- H2: HomePod (or HomePod mini) via transient pairing: audible, volume, teardown.
- H3: a legacy receiver (AirPort Express or similar `_raop._tcp`-only device): PIN pairing
  (task 11), then legacy L16 with the produced seed.
- H4: Apple TV shows artwork and progress (task 13); RAOP discovery finds each tested receiver (task 9).
- Depends on: 9, 11, 12, 13.

### Phase 4 — Evidence-gated / deferred

**17. Uncompressed ALAC frames (only if H3 or another receiver rejects L16)**
- Files: new `src/raop/alac.ts` (module comment), `src/raop/stream.ts` (SDP
  `a=rtpmap:96 AppleLossless` and matching `fmtp` when `cn` lacks `0` but has `1`).
- Types: `export function alacVerbatimFrame(pcm: Buffer): Buffer` (352 stereo PCM16 frames,
  escape/uncompressed frame, bit-packed).
- Test first: `src/raop/__tests__/alac.test.ts` against fixtures decoded by an independent
  ALAC decoder (e.g. ffmpeg on a CAF wrapper generated in the scratchpad, recorded as hex),
  including a short final frame.
- Depends on: 6 and hardware evidence. Not started otherwise.

**18. Buffered AirPlay 2 audio spike (no production code)**
- Output: a short findings section appended to this document: what buffered `type: 103`
  streams need (compressed AAC/ALAC payloads, TCP data channel, rate/anchor-time commands,
  possibly PTP instead of NTP) and whether any receiver actually requires it over realtime.
- Depends on: 7.

## Parallelism

| Can run together | Must be sequential |
| --- | --- |
| 1, 2, 3, 4, 8, 9, 10 | 2 + 4 → 5 → 6 → 7 |
| 11 after 10, independent of Phase 1 | 6 → 12 → 13 (same file; 12 and 13 may swap but not overlap) |
| 15 any time after 4 once PR #43 merges | 6 + 8 + 9 + CLI track → 14 |
| | 9 + 11 + 12 + 13 → 16 |

Tasks 2, 3, 6, 12 and 13 all edit `src/raop/stream.ts`; give them to one agent in order, or
land 2 and 3 before 6 starts.

## Phase boundaries

- **End of Phase 1:** checkpoint after H1. Report whether real Apple TV audio works before
  starting Phase 2. If H1 fails, debug with captured evidence before adding scope.
- **End of Phase 2:** discovery, WAV, legacy pairing merged; the library alone can find a
  receiver and stream a WAV file.
- **End of Phase 3:** HomePods, artwork/progress and the CLI path; #22 can be closed only if
  H1–H4 pass. Phase 4 stays open as follow-up issues, not as #22 scope.

## Risks

- **No hardware evidence yet.** Every byte-level claim above comes from the reference
  implementation and loopback tests; Apple receivers may reject details (stream SETUP keys,
  `audioFormat`, latency, sample byte order for `ct: 1`) silently. H1 is the gate.
- **Random `shk`.** The reference derives `shk` from event keys and notes any 32-byte value
  works; we use random bytes. Unverified on hardware.
- **Latency.** Legacy rejects a non-66,150 `Audio-Latency`; AirPlay 2 receivers may answer
  differently. The plan accepts it for `airplay2` and keeps the 66,150-frame send schedule;
  sync timing may need the negotiated value instead.
- **Timing protocol.** Recent tvOS may prefer PTP. Realtime streams declare NTP and the
  reference still works with NTP, but this is a known way for H1 to fail.
- **Event channel.** If it is not connected and answered promptly, receivers tear the session
  down. Task 4 retries refused connects like the reference; timing on hardware is unverified.
- **Session id.** AirPlay 2 receivers may omit the RTSP `Session` header; the plan falls back to
  `Session: 0` like the reference. Unverified on hardware.
- **Feature-bit heuristics.** Bits 38/48 are a heuristic for AirPlay 2 support. Misclassified
  receivers fail during SETUP rather than at construction. Bit 40/43-only receivers stay
  rejected (the reference would try AirPlay 1).
- **Conflict with PR #43.** It rewrites `src/airplay-playback.ts`; task 15 waits for it and
  nothing else in this plan edits that file.
- **CLI track coordination.** Task 14 depends on another branch's stream command; rebase on it
  rather than adding a second command.
- **Legacy SRP vectors.** Must come from an independent implementation; self-generated
  vectors would only prove self-consistency. The K formula is already confirmed in
  `fast-srp-hap`; M1 compatibility is what task 10 checks.
- **Security.** Legacy pair-verify authenticates only the client and encrypts nothing; keep the
  trusted-LAN warning in the README. AirPlay 2 keys (`shk`, session keys, seeds) are zeroed on
  teardown where Buffers allow it.

## Needs hardware

H1 (Apple TV 4K, AirPlay 2 realtime), H2 (HomePod, transient pairing), H3 (legacy RAOP
receiver, PIN pairing and L16), H4 (artwork/progress display, discovery). Tasks 17 and 18 are
gated on hardware findings. Everything else is verifiable with `tsc` and loopback `vitest`
tests.
