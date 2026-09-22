# Generating real Dotadle snippets

The public product is **Who dies next?**, a practice-only static fan app:
https://sgoedecke.github.io/who-dies-next/ ([repository](https://github.com/sgoedecke/who-dies-next)).
There is no shipped demo or daily-mode UI. Historical daily-pin measurements
below describe earlier migrations, not current browser behavior.

After setup, run:

```sh
npm run scrape -- --target 50 --max-per-match 5
```

This builds an active corpus of **50 distinct ten-second first-death puzzles
from at least ten matches**, with hard maxima of **five per match** and
**four relevant heroes per snippet**. It uses
verified cached replays first, then downloads and parses additional recent public
replays only if needed. It does not generate synthetic substitutes, simulate
counterfactual actions, or derive playback from match-summary statistics.

The command reports `complete` only when the target is actually reached. A
smaller valid corpus is explicitly `partial` with exit code 2. Read
`public/scenarios/corpus-report.json` for the latest measured result, failures,
source distribution, dates, exclusions and verification status.

## Setup

Run from this project directory:

```sh
npm install
npm run worker:build
npm run dev -- --port 5187 --strictPort
```

Requirements: Node 22.12+, npm, Java 17+, Maven for the initial worker build, and
`bzip2`/`zstd`. The current environment has project-local Java/Maven under
`.tools/`; see [worker/README.md](worker/README.md) for the portable setup.
Clarity 4.0.1 parses the actual uncompressed Source 2 `.dem`.

No Steam login, API key, paid service, cloud deployment or scheduler is needed
for replay ingestion. Steam authentication was used separately for the optional
current-client map reference, not for these replay downloads.

## Single replay to snippets

```sh
# Resolve one public match, reuse its verified cache if available, then publish.
npm run ingest -- --match 9009355617 --count 1

# Parse/import a local real replay; use cached start-time metadata when present.
npm run ingest -- --file .cache/9009344330.dem --count 1

# Compressed local imports are supported too; compression is checked by magic.
npm run ingest -- --file /absolute/path/to/replay.dem.bz2 --count 3
npm run ingest -- --file /absolute/path/to/replay.dem.zst --count 3

# Discover and ingest one recent replay instead of specifying its match ID.
npm run ingest -- --source parsed --attempts 5 --count 3

# Source replay elapsed time, not the in-game horn clock.
npm run ingest -- --file .cache/9009344330.dem --after 1657 --count 1
```

`ingest --count` is **1–3 clips from one replay**, not the corpus size or number
of downloads. Single ingestion also refuses to exceed five active clips from
one match. Adding a new source can temporarily grow the catalog; rerun `scrape`
to select the requested target and archive excess entries.
A local replay whose age cannot be established from replay
metadata or OpenDota's actual match-start timestamp is rejected. File/download
dates never establish eligibility. A Steam replay can expire long before the
180-day age limit; an eligible match does not guarantee a downloadable replay.

## Batch generation, bounds and resume

```sh
# Normal cache-first generation; seeded and bounded.
npm run scrape -- --target 50 --max-per-match 5 --seed dotadle-v1

# Explicit acquisition budget and discovery source.
npm run scrape -- --target 50 --max-per-match 5 --source parsed \
  --attempts 25 --max-new-replays 12 --max-cached-replays 20 \
  --seed dotadle-v1

# No HTTP requests: generate only from sufficiently verified local caches.
npm run scrape -- --target 50 --max-per-match 5 --offline

# Read/verify the active corpus against its source caches, without downloading
# or changing scenario/catalog files. The verification report is updated.
npm run scrape -- --target 50 --max-per-match 5 --offline --verify-only

# Re-run the same generation command after interruption or a partial result.
# It reuses successful downloads/parses and does not duplicate encounters.
npm run scrape -- --target 50 --max-per-match 5 --seed dotadle-v1
```

| Flag | Default | Bound / meaning |
| --- | ---: | --- |
| `--target` | 50 | 1–100 real snippets; release publication currently requires exactly 50 |
| `--max-per-match` | 5 | 1–5, never above five, including preserved entries |
| `--source` | `parsed` | OpenDota `parsed`, `public`, or `pro` discovery |
| `--attempts` | 25 | At most 1–40 discovered candidate matches per run |
| `--max-new-replays` | 12 | 0–20 new download attempts/preparations; failed downloads count |
| `--max-cached-replays` | 20 | Read at most 1–30 cached replay sources per run |
| `--seed` | `dotadle-v1` | Reproducible shuffle/tie-breaking given the same candidates and retained corpus |
| `--offline` | false | No discovery, download or missing-metadata HTTP lookup |
| `--verify-only` | false | No acquisition or scenario/catalog rewriting; strict count/cap verification |

Acquisition is serial. Match resolution waits 1.5 seconds between candidates;
HTTP failures use the existing bounded retry/backoff and `Retry-After` handling.
Discovery prefers the last six days for replay availability, while the hard
eligibility policy remains a verified start within **180 days**. Explicit/local
sources can cover the rest of that window if their replays are available.

Per-request limits remain: OpenDota JSON 8 MiB / 30 seconds; compressed replay
256 MiB / 180 seconds; decompression 1.5 GiB / 120 seconds; Clarity ten minutes;
parsed JSON 256 MiB. Replay URLs/redirects are restricted to Valve replay hosts
and expected Dota replay paths. Another download is refused below 4 GiB of free
disk space. The default batch may attempt up to 12 downloads, not an unbounded
scrape or full Steam depot installation.

## What makes a snippet acceptable

The extractor starts approximately six seconds before a recorded hero death and
keeps a complete ten-second sampled continuation. Acceptance requires:

- A valid canonical scenario, ordered complete frames, a living positioned
  victim, at least two living answer options and opposing participants.
- Readable initial positions/HP/max HP for offered heroes, plus observed
  opposing-hero damage in the clip.
- An unambiguous first participant death from actual replay events; near-tied
  deaths within the sampling interval are rejected.
- At most **four distinct relevant heroes**, never a truncated roster. Seed
  participants are living/unknown-life heroes within 2,400 world units of the
  victim (its last living location after death). Then the entire connected
  hero interaction graph is included, in both directions, to a fixed point:
  remote attackers, their targets and support cannot silently disappear.
  A referenced hero missing from the setup rejects the encounter. Inactive
  old corpses do not count merely by proximity, but remain relevant if involved
  in recorded interactions, including damage after death.
- Every participant has observed positions throughout the clip. All recorded
  trajectories, including dead-state positions, must fit within **3,200 world
  units on each axis**. Global/outlier/teleport windows that cannot be framed
  tightly are rejected rather than cropping important actors.
- A stable, hero-only camera: trajectory extrema plus **240 world units**
  of margin per side, with a minimum **1,000-unit extent** per axis. Nearby
  observed towers remain in the data but cannot expand this camera.
  Sampled temporary trees use this actual crop. Coordinates are never spread
  apart to separate heroes; the UI handles overlapping markers and labels.
- At least **15 seconds between clip starts in the same match**. Ten-second
  windows therefore cannot overlap; shifted copies of the same source death
  are also deduplicated.
- At most five clips per actual match ID, including different hashes of the
  same match, existing entries and daily-pinned entries.

Selection packs non-overlapping windows, then uses the seed and match balancing.
There are **no hero or victim quotas/rankings**. Hero/answer counts in the report
are descriptive measurements, not optimization targets. This selects coherent
recorded encounters, not necessarily the best tactical puzzles or optimal-play
counterfactuals. Escape questions are not implemented.

Before publication, every retained/new clip is checked against the source:
exact sampled hero state, levels, abilities, items, cooldowns, towers, trees,
events and times; independently derived first death; regenerated participant
selection/bounds; schema, identity, age, unique outcome and window spacing.
Unknown values remain unknown.

## Files and publication

| Location | Contents |
| --- | --- |
| `.cache/<match>.dem[.bz2]` | Original downloaded/decompressed replay bytes |
| `.cache/<match>.match.json` | Actual match-start/acquisition metadata |
| `.cache/<match>.download.json` | URL and decompressed SHA-256 |
| `.cache/<sha>-clarity-4.0.1-v3.json` | Normalized replay frames/events |
| `.cache/<sha>.provenance.json` | Source identity/date and parsed-cache SHA-256 |
| `public/scenarios/replay-<match>-<start-ms>.json` | Canonical real snippet |
| `public/scenarios/index.json` | Active real-only catalog; legacy daily metadata is ignored by the app |
| `public/scenarios/corpus-report.json` | Latest generation/verification report |
| `.cache/corpus-reports/corpus-<run-time>.json` | Local terminal run reports; never deployed |
| `.cache/retired-scenarios/<run-time>/` | Excess previously published entries archived when enforcing the cap |

Source and parsed-cache digests are verified. Once a provenance record exists,
corrupting the parsed JSON is an error, not a silent reparse or success-shaped
fallback. Changing the worker format requires a deliberate cache-version update;
do not casually edit cached JSON or its checksum. Caches and original downloads
are ignored, and the dev server denies private-cache access.

If published snippets exist but their source caches are missing, online generation
tries to reacquire those match IDs within the same candidate/download budget.
Only entries whose raw source can actually be verified count toward the target;
unavailable sources are reported and never treated as successful cache hits.
Offline verification requires the checked source caches to be present.

Scenario files are written atomically before the catalog is replaced. Existing
unchanged retained files are not rewritten during resume. A policy migration
first checks historical source state, then regenerates canonical participants
and framing. Camera-only changes can update the same ID without invalidating
saved answers. If an old ID would acquire different heroes, choices or an
answer, that window is rejected and archived instead of reinterpreting a saved
guess. Its ID is retained in the catalog's `retiredQuestionIds`, so a later
resume cannot resurrect that changed question. `updatedScenarioIds`, retirement reasons and changed daily pins are
recorded; strict `--verify-only` never treats an in-memory regeneration as
verification of an outdated file on disk. The active index contains only
the accepted real corpus, with no demo or synthetic entry. Excess
old snippets are moved out of the public directory after publication, not used
to inflate the count. A hard cap can retire old entries; current-day pin priority
does not exempt a match or encounter from either hard cap. Changed daily pins and archived IDs are
explicitly recorded in the report.

The batch retains backward-compatible daily metadata for old ingestion users;
the current browser ignores it. It does not install an OS scheduler.
The app is practice-only: **Next** chooses a random eligible real clip other
than the current one, resetting to a fresh frozen setup. There are no mode tabs,
daily completion locks or saved-answer restoration.
There is no dropdown; `/?scenario=<id>` selects an active clip directly.
Guessing locks the answer and starts actual playback.

## Publish a corpus refresh

Pages runs only static files. Acquisition, parsing and optional map extraction
remain local maintenance tasks; never upload their private caches or raw inputs.
After generating and verifying the corpus:

```sh
npm run assets:prepare
npm test
VITE_BASE_PATH=/who-dies-next/ npm run build
# Stage only the intended source and generated public corpus/assets.
git diff --cached --stat
npm run audit:publish
git commit
git push origin main
```

The `Deploy GitHub Pages` workflow checks, builds, audits and deploys `dist/`.
It uses the `/who-dies-next/` base for all runtime URLs. Monitor the workflow
and verify the actual public page after deployment; a pushed workflow alone
is not deployment evidence. Required image assets are an app-specific subset,
not a standalone Valve asset catalog. Preserve `THIRD_PARTY_NOTICES.md`.
Public publication does not authorize redistribution of raw replays, depot
archives or client tools. Root `.gitignore` and the publication allowlist cover
these exclusions. Re-run the audit after changing the staged file list.

## Terrain and version limits

The 180-day rule is **not** map compatibility. Static terrain/base trees are
used only for exact replay ID/hash pairs with the existing 22-tower alignment
evidence and recent client assets. New unchecked matches omit this reference;
their replay-observed positions/towers/temporary trees still work.

Cached authorized client assets can be rechecked without signing in again:

```sh
npm run map:extract
```

This runs actual per-replay tower/source checks before adding compatibility
records. Failure does not justify broadening compatibility to all recent
matches. Exact server-build identity and permanent-tree cut/regrowth state
remain unknown even when tower anchors match. Elevation is collision-checked
sampled reference data, not a pathing/vision simulator. See
[docs/map-assets.md](docs/map-assets.md).

## Failures and checks

Exit **0** means the target was generated or verified. Exit **2** means a
strictly valid but undersized corpus; repeat with a reasonable new budget/source
after inspecting the report. Exit **1** means an explicit error, such as invalid
flags, unknown/stale match age, corrupt cache, source mismatch, lock contention
or a cap violation during verification. There is no dummy padding.

OpenDota can return transient 429/5xx errors or omit replay salts. A specific
match endpoint returned HTTP 522 during this work while fresh parsed/pro match
details still worked. A cached eligible replay does not need that endpoint to
be healthy. External availability is recorded per candidate, not hidden.

Both ingestion commands share `.cache/ingest.lock`. Do not run them concurrently.
After a forced kill, confirm the recorded process has stopped before removing
that one stale lock file; never remove an active run's cache.

```sh
npm test
npm run test:browser
npm run build
npm run scrape -- --target 50 --max-per-match 5 --offline --verify-only
```

## Current four-hero result: 2026-09-21 UTC

The compact-encounter rebuild completed with this bounded command:

```sh
npm run scrape -- --target 50 --max-per-match 5 --source parsed \
  --max-new-replays 3 --attempts 8 --seed dotadle-v1
npm run map:extract
```

**50 real snippets from 11 matches**: nine matches contribute five each,
`9009449291` contributes three, and `9009461455` contributes two. There are
**11 two-hero, 14 three-hero and 25 four-hero** clips, covering 56 distinct heroes
and 34 first-death victims without hero/victim ranking. The minimum same-match
start gap is **26.766625 seconds**. Match starts span
**2026-09-21 08:39:57–21:30:57 UTC**, verified against actual match-start metadata.

The ten existing caches could supply only 45 acceptable clips within the
four-hero, compact-path and five-per-match limits. One additional recent public
match, **`9010373602`**, was downloaded: **31,525,025 compressed bytes**, parsed
into **7,382 frames, 25,204 combat events and 63 observed real-hero deaths**.
There was one download/candidate attempt and no acquisition failure. Its
decompressed replay SHA-256 is
`9a0103eb3dce88ff429530850acca4e99aa892e417473f81602ecb41e26fc68d`.
The run examined 592 death windows, with 479 extraction/identity rejections
and 113 admitted candidates before spacing, combat-quality and match-cap
selection.

**38 old clips were archived and replaced; 12 retained IDs were tightly
reframed.** The existing daily `replay-9009355617-298767` and its question
survived unchanged; 38 future daily pins changed. Its world bounds shrank from
approximately **2363 × 5280 to 1743 × 1892** units because nearby towers no
longer expand the camera. Three changed-question IDs are permanently recorded
in `retiredQuestionIds`. Original temporary-tree/tower-destruction showcase
clips `replay-9009355617-610500` and `replay-9009344330-1442767` were retired,
not exempted from the hard cap. The active 50 clips currently contain no
observed tree-life or tower-life transition; renderer support remains, but
those historical showcases are not presented as current playable puzzles.

The acquisition/migration evidence is preserved in
local history file `corpus-1790028844294.json` (retained under
`.cache/publication-history-reports/` during release cleanup).
That report correctly omitted static terrain for the new replay until the
separate map check ran. Subsequently **all eleven exact replay hashes passed
all 22 tower XYZ anchor checks each (242 checks)** against the cached authorized
map, with XY error below 0.016 and Z error below 0.032 world units. No Steam
authentication or new client download was needed; exact replay builds and
permanent-tree cut/regrowth state remain unknown.

The default generation command, explicit-match command, cached local-file import
and strict offline verification were exercised after the rebuild. An additional
offline resume preserved **all 50 IDs, catalog order and snippet SHA-256s**,
with zero downloads. Every active file is checked against its original replay
frames/events, complete regenerated participant set, first-death outcome,
age, camera containment, uniqueness, spacing and both hard caps.

The completed UI pass uses uniform coordinate scaling, 36–46 px portraits and
collision-separated name/HP/mana callouts with leader lines. Only callouts move;
hero anchors remain at their recorded positions. Reserved inset space prevents
the minimap from covering heroes without expanding the authoritative world crop.
Desktop, mobile and 320 px late-frame screenshots were inspected. Final checks
passed: **151 unit tests, 46 browser tests and the production build**, including
**39,870 frame/midpoint–selection–viewport combinations across all 50 clips**
with no callout or minimap collisions. Autoplay, levels, then-current daily restoration and
random Practice Next remain covered.

## Earlier ten-match rebuild: 2026-09-21

The following acquisition command completed end to end:

```sh
npm run scrape -- --target 50 --max-per-match 5 --source parsed \
  --max-new-replays 12 --attempts 25 --seed dotadle-v1
```

**50 accepted real snippets, ten distinct matches, exactly five per match.**
Eight additional Valve replays were downloaded (217,307,534 compressed bytes
total) and parsed by Clarity; the original two verified caches were reused.
There were eight candidate/download attempts and zero candidate failures in
this run. Match starts span **2026-09-21 08:39:57–10:59:22 UTC**.

| Match | Active snippets |
| --- | ---: |
| `9009344330` | 5 |
| `9009355617` | 5 |
| `9009444124` | 5 |
| `9009445367` | 5 |
| `9009447292` | 5 |
| `9009449291` | 5 |
| `9009452075` | 5 |
| `9009456388` | 5 |
| `9009461455` | 5 |
| `9009470306` | 5 |

The resulting clips naturally contain **64 distinct heroes and 32 first-death
victims**, without hero/victim ranking. The smallest observed same-match
start gap is **42.5 seconds**, above the required 15 seconds.
There were 447 extractable candidate windows before deduplication, quality,
spacing and cap selection. All 50 accepted outputs were checked against
the original normalized replay states/events and regenerated encounter context.

The earlier two-match corpus was rebuilt, not grandfathered in: **40 excess
entries were archived**. All six original fixtures and the current-day pin
`replay-9009355617-298767` survived within the cap; **40 future pins changed**.
The active catalog has 50 distinct daily slots and exactly 50 real snippet files
(plus the then-present synthetic sample, which has since been deleted).

The original rebuild report is retained at
local history file `corpus-1789989808013.json` (retained under
`.cache/publication-history-reports/`, not published).
It records the acquisition counts, rejection reasons and pin/archive changes.
Subsequent reports describe their own runs rather than pretending they
downloaded those eight replays again.

Afterward, `npm run map:extract` successfully checked **all ten exact replay
hashes against all 22 named tower XYZ anchors each** using the cached current
client map: 220 anchor checks, maximum XY discrepancy below 0.016 world units
and Z discrepancy below 0.032. The reference was not assumed compatible from
recency. Exact server builds and permanent-tree life state remain unknown.
No new Steam sign-in was needed.

The default generation command was then rerun successfully: **50 reused,
zero new snippets, zero downloads**, with every published snippet ID and SHA-256
unchanged. The cached single-match and local-file commands above were also
executed successfully after the shared pipeline refactor.
