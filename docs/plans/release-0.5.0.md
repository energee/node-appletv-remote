# 0.5.0 release plan

Everything between `main` today (`3e58675`) and `node-appletv-remote@0.5.0` on npm. Pushing a
`v*` tag publishes to npm through `publish.yml`, so the tag is the point of no return; the
maintainer pushes it. Each step ends at a checkpoint: report results, wait for approval.

Most features merged since v0.4.0 (#92–#100) were merged as drafts "pending hardware
validation", so steps 3–4 are the real release gate. **Policy:** anything that fails is fixed
before the tag; nothing ships labelled experimental to cover a failed check.

**Devices:** Family Room (`FR` = `16:D2:C1:61:76:4C`, AppleTV6,2, tvOS 26.6, AirPlay +
Companion pairing, AirPods available) and Master Bedroom (`MB` = `FA:7A:B4:1F:C5:CC`,
AppleTV5,3, tvOS 26.6, AirPlay pairing only). No legacy DMAP device, third-party RAOP receiver
or HomePod is available.

**How to run:** `npm run build` in the worktree, then `node dist/cli/index.js …` (written `atv`
below). Node needs local-network access, so run outside the agent sandbox. **You** = a physical
action or on-screen observation by the maintainer.

## Step 1 — fix PR: CLI credential import and test isolation

Branch `fix-cli-legacy-import` (worktree `.claude/worktrees/release-0.5.0`). Already done and
uncommitted:

- `vitest.setup.ts` + `vitest.config.ts`: every test file gets a temp `HOME`. Before this, the
  `dmap-pair` CLI test saved a fake DMAP record into the real `~/.atv-storage.json` (the CLI tests
  mock `node:fs`, but `FileStorage` writes through `node:fs/promises`), which made the CLI skip
  the legacy import and report `credentials_unavailable`. Test: `test-isolation.test.ts`.
- `src/cli/index.ts`: old `atv pair` records import as AirPlay (every released `atv pair` used
  AirPlay pair-setup), or as standalone MRP when the cached hints show only an MRP port, instead
  of "unclassified" records the CLI never uses, which forced every 0.4.0 user to re-pair.
  Test: `cli-legacy-import.test.ts`.
- `src/cli/index.ts`: "No configured implementation" maps to JSON `credentials_unavailable`
  instead of `operation_failed`. Test: `cli-json.test.ts`.
- `src/storage.ts`: drop the now-unused, never-released `FileStorage.setUnclassifiedHap`.
- `docs/cli.md`: describe the new import.

Remaining tasks (each test written first and seen failing, or passing where it pins existing
behaviour):

| # | Task | File | Acceptance |
|---|------|------|------------|
| 1.1 | Old Companion-only pairing (outer key = Companion key) imports as Companion only | `src/__tests__/cli-legacy-import.test.ts` | test passes |
| 1.2 | Legacy DMAP GUIDs and device hints import alongside HAP credentials | same | test passes |
| 1.3 | The import runs once: an existing storage file is never re-imported | same | test passes |
| 1.4 | An ambiguous device selector reports JSON `invalid_arguments`, not `operation_failed` (an unmatched one already reports `credentials_unavailable`) | `src/cli/index.ts`, `src/__tests__/cli-json.test.ts`, `docs/cli.md` | test fails first, then passes |
| 1.5 | `volume` no longer keeps the last level after the output loses absolute volume (seen with AirPods detaching from FR); the next absolute output is queried again | `src/appletv.ts`, `src/__tests__/mrp-correlation.test.ts`, `docs/library.md` | test fails first, then passes; FR AirPods detach/reattach on hardware |
| 1.6 | `/simplify`, `tsc --noEmit`, `vitest run`, build; commit; PR; CI green; merge | — | merged to `main` |

**Checkpoint 1:** PR merged, CI green on `main`.

## Step 2 — automated release gate

| ID | Check | Pass when |
|----|-------|-----------|
| A1 | `npx tsc --noEmit`, `npm test`, `npm run build` on `main` | clean, all tests pass |
| A2 | `shasum ~/.atv-*.json` before and after `npm test` | unchanged |
| A3 | `npm pack --dry-run` | only `dist/` (no `__tests__`), `LICENSE`, `README.md`, `package.json` |
| A4 | Install the packed tarball into a temp project; `npx atv help`; `import('node-appletv-remote')`; `tsc` against its types | CLI runs, ESM import works, types resolve |

**Checkpoint 2:** report A1–A4.

## Step 3 — hardware, read-only (mostly the agent)

| ID | Feature (PR) | Command | Device | Pass when |
|----|--------------|---------|--------|-----------|
| H1 | Discovery | `atv scan` | both | both TVs listed with model and `psi` |
| H2 | Targeted mDNS (#99) | `atv scan --host 192.168.4.51 --host 192.168.4.59` | both | both found through the direct query |
| H3 | Storage + routing (#93, #100) | `atv power FR`, `atv text focus FR`, `atv app list FR` | FR | answered over Companion from stored credentials |
| H4 | MRP state (#10) | `atv state FR`, `atv queue FR` | FR | current item, or "Nothing playing" when idle, no error |
| H5 | JSON results (#96) | `atv --json state FR`, `atv --json app list FR`, `atv --json output list FR` | FR | one `result` line each, `version: 1`, `deviceId` = resolved ID |
| H6 | JSON watch (#96) | `atv --json watch FR` 30 s, then Ctrl-C | FR | `connection`, `playback`, `volume`, `output-devices` events; last line `watch-close`, `reason: "signal"`; exit 130 |
| H7 | Initial volume (#103) | `atv --json watch FR` with AirPods connected | FR | `volume` `state: "known"` within 1 s, matching the AirPods level |
| H8 | No false volume (#103) | `atv --json watch MB` on TV speakers | MB | `volume` stays `unknown`, never 0 |
| H9 | Rich metadata (#95) | `atv --json state` while something plays; `atv artwork FR art.jpg` | both | title, series/artist, season, app and position match the screen; artwork is a valid image |
| H10 | Output routing | `atv output list FR` | FR | lists the Family Room output |
| H11 | Device selectors (#93) | `atv --json state` with no selector, `16:D2`, a full key, an ambiguous prefix, an unknown name | both | the last record; the matching TV; the matching TV; `invalid_arguments`; `credentials_unavailable` |
| H12 | Companion pairing into storage (#93) | `atv companion-pair` on MB (**You** read the PIN), then `atv power MB` | MB | Companion credentials added next to the AirPlay ones; `power` answers |

**Checkpoint 3:** report H1–H12. Every failure is fixed (test first) and re-run before step 5.

## Step 4 — hardware with effects on the TV (needs You at the TVs, ~15 min)

| ID | Feature (PR) | Command | Device | Pass when |
|----|--------------|---------|--------|-----------|
| E1 | Routed keys (#100) | `atv command down FR`, then `atv command up FR` | FR | **You** see focus move down, then up |
| E2 | Companion-only control (#92) | library script: `connectCompanion` only; `down`, `up`, `playPause` | FR | **You** see focus move and playback toggle, no AirPlay connection open |
| E3 | Companion sleep/wake (#84) | `atv command suspend FR`, wait 10 s, `atv command wake FR` | FR | **You** see the TV sleep, then wake |
| E4 | Absolute volume (#103) | `atv volume 40 FR` with AirPods, then `atv --json watch FR` | FR | AirPods level about 40%; watch reports about 40 |
| E5 | Local media (#98) | library script: `playFile` on a 30 s ffmpeg MP4 (`testsrc` + sine) | FR | **You** see and hear it; the temporary HTTP server closes afterwards |
| E6 | Audio decoding (#94, #79) | `atv raop-stream 192.168.4.51 tone.mp3` (ffmpeg 10 s tone) | FR | **You** hear it; Ctrl-C stops cleanly |
| E7 | RAOP metadata (#97, #80) | E6 with a tagged MP3 that has artwork | FR | streams; nothing shown (known tvOS 26.6 limitation, #22) |
| E8 | Text entry | **You** open a search field; `atv text focus FR`, `atv text set hello FR`, `atv text clear FR` | FR | focus `focused`; "hello" appears, then clears |

**Checkpoint 4:** report E1–E8. Every failure is fixed (test first) and re-run before step 5;
only a documented tvOS limitation (like E7) may ship as a known limitation.

## Step 5 — release PR

Branch `release-0.5.0`, from `main` after step 1.

| # | Task | File |
|---|------|------|
| 5.1 | Bump the version to `0.5.0` | `package.json` (pnpm lockfile has no package version) |
| 5.2 | Add `CHANGELOG.md` for 0.5.0: features since v0.4.0, fixes, **breaking changes** (Node ≥ 20.19 #56; DMAP capability keys renamed #52; credentials move to `~/.atv-storage.json`, imported automatically from the old files #93), and what stays hardware-unverified | `CHANGELOG.md` |
| 5.3 | Update the README Status table with steps 3–4 results; link the changelog | `README.md` |
| 5.4 | Commit this plan with all results filled in | `docs/plans/release-0.5.0.md` |
| 5.5 | Draft closing comments for #78–#90 (what was verified, what remains); post after approval | GitHub |
| 5.6 | CI green; merge | — |

**Checkpoint 5:** release PR merged, issue comments approved and posted.

## Step 6 — publish (maintainer) and follow-up

1. **You:** confirm the `NPM_TOKEN` repo secret is valid (it had expired before v0.4.0).
2. **You:** `git tag v0.5.0 <merge commit> && git push origin v0.5.0`; `publish.yml` tests and
   publishes with provenance.
3. Verify: the publish run is green, `npm view node-appletv-remote version` is `0.5.0`, and a
   fresh `npx node-appletv-remote@0.5.0 help` works.
4. GitHub release `v0.5.0` with the changelog section as notes.
5. Cleanup, with approval: worktrees `pr-103-volume`, `pr-103-land`, the scratch `pr103`, this
   one; local branches `pr-103-review`, `pr-103-volume`, `pr-103-land`; `~/.atv-storage.json.bak`,
   `~/.atv-storage.json.unclassified-import`; the stray `family-room` record in
   `~/.atv-storage.json` (backed up first).
6. File a follow-up issue: unreleased-`main` storage files keep unusable `unclassified`
   credentials (no npm release is affected).

## Results (2026-10-26 to 2026-10-27)

FR = Family Room, AppleTV6,2; MB = Master Bedroom, AppleTV5,3; both tvOS 26.6 (23L773).

| Step | Result | Fixed in |
|------|--------|----------|
| 1 | CLI legacy import and test isolation fixed | #104 |
| A1–A4 | Pass after moving `raop-input.test.ts` out of the published package | #106 |
| H1 | Pass after the fix: scan missed a TV about 1 in 30 (bonjour-service queries once); re-query at 1 s and 3 s gave 0 misses in 30 | #106 |
| H2 | Pass after the fix: targeted discovery lowercased names | #106 |
| H3–H8, H10, H11 | Pass | — |
| H9 | Pass after the fix: Plex paused read as Playing (rate 0) | #106 |
| H12 | Pass on both TVs after the fixes: MB power and app list needed `TVRCSessionStart`; a PIN entered after ~35 s now reports it expired | #106 |
| E1–E4 | Pass (E4 with AirPods; TV speakers do not allow absolute volume) | — |
| E5 | **Known limitation:** progressive MP4 never becomes ready on FR or MB; HLS plays; pyatv's tvOS 26 rework stalls the same way | docs |
| E6 | Pass through `RaopStream` (the CLI cannot stream to HAP receivers, as documented): three tones heard, cancel clean | — |
| E7 | Streams; nothing shown (known #22) | — |
| E8 | Pass: focus, set "hello", clear | — |
| Extra | `atv … "Family Room"` failed: the stored name now selects the TV | #106 |
| Extra | `atv power` on sleeping MB errored: power now reads MRP `logicalDeviceCount` | #107 |
| Extra | Volume renewal after an output change (contributor follow-up), merged for 0.5.0 | #105 |

## Not in 0.5.0

- Hardware-only items: legacy DMAP devices (#52), legacy AirPlay URL playback (#82),
  password-protected RAOP (#81), HomePod transient pairing (#77), deep-sleep discovery (#87),
  IPv6 and non-Apple mDNS (#99), protocol inspection proxy (#91). The changelog lists them as
  unverified.
