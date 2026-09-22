# Scenario format v1

The authoritative executable schemas and inferred TS types are in
`shared/scenario.ts`. A scenario file is JSON, served directly from
`public/scenarios/`. Data is public: this is a client-side prototype, not an
anti-cheating service. Answers are hidden by the interface, not cryptography.

## Clocks and coordinates

- `startTime`: source replay elapsed seconds at the frozen start; **not** Dota
  in-game match-clock time.
- `duration`: bounded continuation, currently ten seconds.
- `sampleInterval`: parser sampling resolution, used also to reject near-tied
  death outcomes that cannot be resolved fairly.
- `startSnapshot.time` and `frames[0].time`: exactly zero. All frame/event times
  in a scenario are seconds relative to `startTime`.
- `frames`: strictly increasing times, starting with an exact copy of
  `startSnapshot`, and covering at least the entire question window. A final
  sample may lie just beyond the end to support position interpolation.
- `coordinateSystem`: `dota-world`. `x`/`y` are world units, not guessed pixels.
  The arena uses a view box enclosing included heroes' sampled positions with
  padding. `bounds` is not a claim about map or terrain boundaries.

## Envelope

```ts
{
  schemaVersion: 1,
  id: string,                       // URL-safe stable id
  title: string,                    // Neutral setup, no answer spoiler
  description: string,
  source: ReplaySource,
  coordinateSystem: "dota-world",
  bounds: { minX, maxX, minY, maxY },
  startTime: number,
  duration: number,
  sampleInterval: number,
  question: {
    kind: "first-death",
    prompt: string,
    windowSeconds: number,         // Must equal duration
    optionIds: string[],           // At least two visible, initially alive heroes
    answerId: string,              // Derived from death events, never guessed
    explanation: string
  },
  startSnapshot: Frame,
  frames: Frame[],
  events: ReplayEvent[],
  limitations: string[]
}
```

Only real replay sources are accepted. Hand-authored regression fixtures live
under `tests/fixtures/` and are never served or included in the published catalog.

`ReplaySource` contains `kind: "replay"`, `label`, nullable `matchId` and `patch`,
`replaySha256` (64 lowercase hexadecimal characters of the decompressed `.dem`),
`parser` (name and version), ISO-8601 `extractedAt` and `acquisition`.
Unavailable patch is null; a numeric provider patch index is not a patch name.
Current files do not include player account identities.

Real sources also carry `matchStartTime` (Unix seconds, nullable only for
unverified/legacy records) and `matchStartTimeSource`. Publishing and playing a
real scenario requires a known start timestamp within the inclusive rolling
180-day window. Legacy/unknown ages are explicitly unavailable, never implicitly
recent. Catalog entries repeat `matchStartTime` for initial eligibility filtering;
the fetched scenario source is checked again before play.

## Frames and heroes

```ts
type Frame = {
  time: number;
  heroes: Hero[];
  towers?: Tower[];
  trees?: Tree[] | null;
};
type Hero = {
  id: string;                      // Stable across clip, maps combat log targets
  name: string;
  team: "radiant" | "dire";
  level: number | null;             // Observed hero XP level; zero != unknown
  x: number | null;
  y: number | null;
  hp: number | null;
  maxHp: number | null;
  mana: number | null;
  maxMana: number | null;
  alive: boolean | null;
  abilities: { name: string; level: number | null; cooldown: number | null }[];
  items: { name: string; charges: number | null; cooldown: number | null }[];
  effects: string[] | null;
};
```

Every frame preserves the same unique participant set. Null means **not observed
or not reliably recoverable**, never “zero.” Empty ability/item arrays mean no
entries were recovered, not proof of an empty inventory. `effects: null` means
unknown; `[]` means no effects observed by a supported extractor. Cooldown is
remaining seconds when reliably measured; zero can mean ready only when the
underlying property and clock are available. Passive abilities with no usable
cooldown state should remain unknown.

The browser interpolates only x/y between adjacent known, living observations.
Other resources and alive/dead state are held at the most recent sample.
This is a replay visualization, not a physics or combat simulation.
Hero levels are also held at the most recent sample, never interpolated or
inferred from ability upgrades. A level-up cannot change the frozen start.

### Observed map context

`Tower` contains stable `id`, observed `name`, `team`, nullable `x`, `y`, `z`,
`hp`, `maxHp`, and `alive`. `Tree` contains stable `id`, nullable `x`, `y`, `z`
and `alive`. Both use the exact same world coordinates and source sample clock
as heroes. Their state is sampled, not interpolated. Missing arrays in older
files mean the layer was not extracted; null trees means unknown coverage.

An optional top-level `mapContext` accompanies these layers:

```ts
{
  towerSource: string;
  treeSource: string;
  treeCoverage: "all" | "temporary-only" | "unavailable";
  terrainSource: string | null;
  limitations: string[];
}
```

Tree coverage must not claim the complete permanent forest when only temporary
network entities are observable. Entity elevation `z` is provenance for that
entity only: **never extrapolate terrain, cliffs, ramps, or vision from hero Z**.
Null `terrainSource` means the replay parser did not supply terrain. A separately
qualified client reference may exist; it is not silently promoted to replay state.

Bounds fit all participant trajectories with a 240-world-unit margin per side
and a minimum 1000-unit extent on each axis. Windows spanning more than 3200
units on either axis, or with unknown participant positions, are rejected.
Towers within 1900 units of those trajectories remain in the sampled context,
but do **not** expand the camera. The same stable rectangle is used throughout
the encounter; hero coordinates are never spread to avoid overlaps. Trees
within that view are retained per sample. Initial
states come from the frozen sample, not the replay's final destroyed/standing
state. Destruction appears only once observed during continuation.
Responsive aspect fitting must preserve the full hero crop and use the actual
visible world rectangle for the minimap; it must not stretch or spread positions.

### Separate current-client map format

`shared/client-map.ts` defines the version-1 client reference contract, currently
published at `/maps/dota-6934.json`. This is deliberately separate from `Frame`:
static client tree coordinates cannot be represented as `alive: true` at an
arbitrary point in a replay.

`source` records the Valve depot/manifest, manifest Unix time, client version,
source revision, map compile time, archive/height-resource SHA-256 and extractor.
Its `heightValidation` records the default-world collision cross-check,
eight-unit maximum vertical deviation, candidate/accepted/rejected counts.
The schema requires accepted counts to equal the number of non-null output cells.
`compatibility` records checked match IDs and exact replay SHA-256, all 22 named
tower anchors, maximum XY/Z discrepancies, and null exact replay builds.
`clientMapEligibility` requires a recent eligible real scenario, recent client
manifest/compile dates and an exact checked ID/hash pairing. Synthetic and
unchecked replays cannot receive this layer.

`trees` contains `{ x, y, z, layer }` actual entity origins, with
`treeState: "base-positions-only"`. Their current standing/destroyed state is
unknown. They do not overwrite the time-indexed temporary trees in frames.

`elevation` contains `{ source: "vhcg-v1", minX, minY, cellSize, width, height,
rows }`. Each row is a list of `[runLength, heightOrNull]`. Rows increase in world
Y and runs increase in world X; each value is sampled at its cell centre.
The schema checks every row covers exactly `width` cells and there are exactly
`height` rows. Rendering uses the existing world-to-screen transform, including
its Y inversion, and clips to the stable encounter bounds. Null stays unknown.
The current output spacing is 64 world units and height rounding is one unit.
Every retained value matches an actual world-collision triangle at the same XY
within eight vertical units; unmatched candidates become null.
These are sampled collision surfaces, not exact ramp polygons, pathing or vision.

`limitations` accompanies the reference itself and remains documented, with
directly relevant marker tooltips rather than Info/Map panels. Coordinate-anchor checks are not proof that
all geometry matches an unknown replay server build.

## Events and outcome

```ts
type ReplayEvent = {
  time: number;
  type: "death" | "damage" | "ability" | "item" | "modifier";
  actorId: string | null;
  targetId: string | null;
  ability: string | null;
  value: number | null;
  description: string;
};
```

The answer is the earliest death where `0 < time <= windowSeconds` and the target
is an offered hero. Different first deaths less than one sampling interval apart
are rejected as ambiguous. The schema verifies that the provided answer agrees
with the observed events. It also rejects invalid bounds, duplicate IDs, unordered
frames, a missing continuation, an inconsistent frozen snapshot, and events after
the question window.

The playable schema permits at most **four distinct heroes**, including all
frames; the raw replay schema remains unrestricted. The extractor does not trim
away nearby participants to satisfy this cap or make the desired answer win.
It seeds living/unknown-life heroes within 2400 world units of the victim,
using its last living location after death. It then closes the entire connected
hero interaction graph in both directions, including remote attackers, targets
and support. Missing referenced heroes, more than four relevant heroes, missing
positions or excessive trajectory span reject the entire window. Inactive
corpses count only if involved in recorded interactions. Deaths
outside the offered hero set are not answers; the UI question is scoped to that
set.

`scenarioArchiveSchema` is only for reading historical files during migration.
It cannot admit a playable scene. Retained historical state is checked against
the original source before canonical reframing; changed hero/choice/answer sets
are retired rather than reassigned to the same ID and saved completion record.

## Intermediate replay format

The worker emits `RawReplay`: `schemaVersion`, nullable `matchId`/`patch`,
`parser: {name: "clarity", version: string}`, `coordinateSystem`, `sampleInterval`,
`frames`, `events`, and `limitations`. Unlike scenario times, raw frame/event
times use one common source replay elapsed clock. The worker must align combat
log timestamps to the entity clock, or explicitly derive death observations from
entity transitions. The ingestion layer validates this format before extracting
or publishing anything.

Raw replay metadata may include `matchStartTime` if reliably recoverable.
Otherwise ingestion resolves the replay's match ID to a public start timestamp
and rejects unknown/stale input. Replay elapsed seconds are not Unix timestamps
and cannot be used to determine match age.

## Catalog

```json
{
  "version": 1,
  "scenarios": [
    {
      "id": "replay-9009355617-298767",
      "title": "Ten seconds on the edge",
      "kind": "replay",
      "path": "/scenarios/replay-9009355617-298767.json",
      "matchStartTime": 1789980832
    }
  ],
  "daily": {}
}
```

The application is practice-only and randomly selects eligible real entries.
Legacy `daily` metadata may remain for ingestion compatibility, but is ignored
by the browser. No pin or prior completion can lock the practice experience.
The optional `retiredQuestionIds` array permanently reserves IDs whose original
participant/question context changed during migration. They cannot be active
catalog entries or be republished by either ingestion command.
