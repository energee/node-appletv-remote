# Internals

How the protocols fit together, how discovery associates services into devices, and how to send raw Companion messages.

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
├── auth/           # HAP pair-setup / pair-verify, legacy AirPlay PIN pair-setup
├── companion/      # Companion Link: OPACK, framing, pairing
├── dmap/           # legacy codec, HTTP session, reverse pairing
├── raop/           # partial RAOP / AirPlay 2 realtime PCM RTP streaming
├── airplay-playback.ts # dedicated URL playback session
├── legacy-airplay-playback.ts # explicit legacy HTTP URL playback + reverse events
├── mrp/            # MRP message builders + generated schema.ts
├── proto/          # .proto sources (build input only)
├── util/           # crypto, TLV, HTTP, HAP framing, AirPlay 2 event channel
└── cli/            # the `atv` command
```

## Legacy HTTP playback

`LegacyAirPlayPlaybackSession` owns one HTTP control socket and one PTTH reverse
socket linked by its generated session identifier. Requests serialize on the control
socket; reverse notices are independently framed and acknowledged. Close, a protocol
error or either connection's loss rejects waiters and destroys both legs and buffers.
An initial stopped notice does not terminate setup; an active session's stopped notice
is acknowledged before local teardown.

`auth/legacy-pair-verify.ts` contains the transport-injected seed proof shared with
legacy RAOP. The HTTP route accepts only optional explicit legacy credentials, not
HAP keys, and never continues after an unsupported proof response. HTTP password
authentication remains unsupported rather than borrowing RTSP Digest assumptions.

XML status/event parsing uses `@xmldom/xmldom` with parser diagnostics converted to
generic errors, one bounded parse, no internal DTD/entities and no binary-plist
fallback. Only required scalar fields are decoded; compound status metadata is not
copied into a second object tree. Selection is explicit; physical legacy receiver
and HTTP-endpoint seed applicability remain hardware gates.

## Storage

`src/storage.ts` exposes a small asynchronous document store used optionally by the
CLI and available to library consumers. The document is versioned and validates HAP
key encodings/lengths, RAOP seed/client ID, and DMAP GUIDs before it can be used.
Secrets live under per-protocol credentials; aliases and endpoint hints are separate
unauthenticated data. `DeviceStorage` keeps mutations dirty until explicit `save()`.
`FileStorage` is a single-writer JSON store: it writes a restrictive same-directory
temporary file then atomically renames it, retaining the prior readable document when
the write fails. It deliberately has no multi-process transaction guarantee and is
plaintext rather than a keychain. `CustomStorage` accepts an adapter with async
`load`/`save` methods for keychains, databases, or cloud-backed applications.


## Discovery and transport selection

`DiscoveredDeviceInfo.port` remains the AirPlay port, and is **0 when AirPlay is absent**. `companionPort` and `mrpPort` are independent capabilities, not substitute AirPlay ports. `mrpEnabled` is false for Darwin build 19+ (tvOS 15+), where the legacy MRP advertisement no longer indicates a usable transport. Unknown builds retain legacy MRP eligibility.

`AppleTV.connect()` and `startPairing()` preserve the AirPlay tunnel when advertised, otherwise select enabled standalone MRP. Companion-only devices use `connectCompanion()` and `startCompanionPairing()`; calling the MRP methods fails before opening a socket. Standalone credentials use the existing `Credentials` format but must be paired with the selected protocol; AirPlay pairing does not imply legacy MRP pairing. A returned PairSetup owns its open pairing carrier: always call `finish(pin)` or `destroy()`; abandoning it without either intentionally leaves pairing open. `PairSetup.clientId` is a public readonly controller pairing identifier (a random UUID per instance); it is sent in M5 and returned as `clientId` in the finished credentials.

`DeviceSession` is the shared high-level routing policy used by the CLI. Each configured
provider owns its actual `AppleTV` or `DmapClient`, so credentials, request correlation,
handshake readiness and encryption counters remain per carrier. The operation table
contains only implemented public methods; discovery ports do not establish runtime support.
Metadata/queue/routing/power prefer MRP, while apps/text/touch prefer Companion. Explicit
preferences are strict, and no failure after dispatch triggers a second provider.

Handlers attach before setup. Normalized setup state is coalesced until the provider is
ready and forwarded only from its authoritative source. Optional failure is observable,
required failure closes the attempt, and close-during-setup cannot resurrect a provider.
Terminal DMAP authentication loss emits `close` and invalidates the routed cached state;
ordinary request errors remain the original operation failure. Session closure detaches
forwarding before closing each owned client and does not initiate reconnect.


A standalone MRP connection sends a heartbeat (a GenericMessage) every 30 s, never overlapping another. Any reply carrying the request's identifier counts, whatever its type; a miss is retried once immediately, and a second miss fails the connection.

Discovery associates modern services by compatible advertised identity, primary-protocol hostname, or overlapping primary-protocol addresses, never by display name. AirPlay `deviceid` and MRP `macAddress` share a MAC namespace; MRP `UniqueIdentifier` and Companion `rpMRtID` share an MRP namespace. Other cross-protocol ID equality does not establish an association. Conflicting IDs within a namespace keep devices separate. Same-protocol records with disjoint addresses and different SRV hosts remain separate even when their IDs match; duplicate device IDs are ambiguous, not verified identities. Primary endpoint overlap is scoped to the selected protocol host. Records matching multiple groups remain separate instead of bridging them, independent of arrival order; an ambiguous result must not be treated as a verified TV.

`_raop._tcp` instance names have the form `<MAC hex>@<name>` (for example `AABBCCDDEEFF@Living Room`). A RAOP record joins the AirPlay device whose `deviceid` is that MAC, compared case- and colon-insensitively, under the same conflict and ambiguity rules; records whose name lacks `@` or a 12-hex-digit MAC are ignored. RAOP-only receivers (no matching AirPlay advertisement) become their own devices: `name` is the part after `@`, `address`/`raopAddress` the RAOP address, `port` 0 (no AirPlay), `deviceId` the colon-separated upper-case MAC, and `model` the RAOP `am` TXT value when present. `raopTxt` is the TXT record with lower-cased keys, ready for `new RaopStream(device.raopAddress!, device.raopPort!, device.raopTxt!)`. Like every mDNS association, this one is not authenticated.

DMAP instance names are not universal device IDs: `deviceId`/`identifiers` use `dmap:<instance>` instead of a raw instance name. Migrate stored legacy instance lookups to that prefix. DMAP requires direct address overlap with the primary protocol and never joins by hostname or instance name alone. `identifiers` retains the modern aliases for cached credential lookup, but every alias is unauthenticated mDNS data, not proof of identity. The primary `deviceId` prefers AirPlay, then MRP, then DMAP, then Companion, then RAOP. If no ID is advertised, discovery falls back to hostname/service instance (not IP). Changed advertisements can change the primary ID; match stored IDs against `identifiers` too, as the CLI does. These association checks prevent unrelated endpoint selection, not mDNS spoofing or an attacker advertising the same endpoint.

IPv4 is preferred when advertised; global/ULA IPv6 and explicitly scoped link-local IPv6 (for example `fe80::1234%en0`) are accepted. Unscoped link-local, loopback, unspecified, and multicast addresses are excluded. Use unbracketed addresses for constructors; the RTSP layer brackets IPv6 authorities. `companionAddress`, `mrpAddress`, `raopAddress`, and `dmapAddress` prefer an address shared with the primary protocol. Modern services joined by compatible identity or hostname can retain disjoint service-specific endpoints; joined DMAP endpoints must be shared. Dual-stack/multihomed advertisements for the same primary identity retain their usable addresses for overlap checks. No automatic connection retry across alternate addresses is added. Exceptions in `scan` filter/until callbacks reject the scan promise after stopping discovery.

Tests use synthetic peers only; IPv6 network discovery and older-tvOS hardware interoperability still require operator validation. An AirPlay advertisement alone does not prove AirPlay 2 MRP or URL-playback compatibility. `createClient` treats known AppleTV1-3 model advertisements as legacy AirPlay; explicit protocol selection remains available.

## Advanced: raw Companion messages

For anything not wrapped yet, send Companion messages yourself:

```typescript
const reply = await atv.sendCompanionRequest('FetchAttentionState', new Map());
atv.sendCompanionMessage('_interest', new Map([['_regEvents', ['SystemStatus']]]));
```

- A reply carrying `_em` or a present, nonzero `_ec` rejects; a request is accepted only after its correlated reply.
- Plain content is wrapped as `{ _i, _t, _c, _x }`. `_t` is 2 for a request and 1 for a message. If you pass a prebuilt envelope (with `_t`, `_c` or `_x`), only `_i` and `_x` get filled in.
- Companion HID controls use `_hidC` content `{ _hBtS: 1|2, _hidC: code }`; media controls use `_mcc`. `_skpS` and `_vol` must be `new OpackFloat(...)` because Companion requires float64 even for whole values.
- Request IDs stay in 1..127, since Apple TVs read larger single-byte IDs as negative. A timed-out ID stays reserved for 30s so a late reply can't resolve the wrong request.

The OPACK and framing tests use independent wire fixtures, including published OPACK examples.
