# Clarity replay worker

Real `.dem` decoding using **Clarity 4.0.1**, protobuf 6.1, Java 17+, and Maven.
No synthetic game state is generated. This worker does not download replays or
contact Steam; supply a locally available, decompressed `.dem`.

## Build and run

From the project directory:

```sh
worker/build.sh
worker/run.sh /absolute/path/match.dem --output /absolute/path/match.json
# JSON stdout instead (diagnostics are stderr):
worker/run.sh /absolute/path/match.dem > worker/match.json
# Optional sampling interval and schema diagnostics:
worker/run.sh /absolute/path/match.dem --interval 0.5 \
  --output worker/match.json --inspect worker/properties.txt
python3 worker/verify-output.py worker/match.json
```

`build.sh` runs unit tests and produces `worker/target/replay-worker.jar`, a shaded
executable jar. Scripts work from any current directory; supplied replay/output
paths are resolved relative to the caller. `--interval` defaults to 0.25 seconds
and accepts finite values from 0.1 through 10. Sampling is quantized to demo
ticks, so adjacent times need not differ by exactly that interval.

Suitable Node invocation:

```js
spawn("/absolute/project/worker/run.sh", [
  "/absolute/input.dem", "--output", "/absolute/output.json",
], { stdio: ["ignore", "ignore", "pipe"] });
```

Wait for exit code **0** before reading an output file. Caught failures exit nonzero,
remove the deterministic `<output>.partial` file, and leave an existing output untouched.
Without `--output`, stdout may contain incomplete JSON on failure; discard it.
`--help` prints usage to stderr. `JAVA_TOOL_OPTIONS=-Ddotadle.debug=true` enables
exception traces. The runtime has a 2 GiB Java heap ceiling.
`run.sh` uses `exec java`, so killing the spawned shell PID terminates the parser
instead of leaving an orphan JVM. An uncatchable `SIGKILL` can leave a
`<output>.partial` artifact; callers should remove that exact path after
confirming the worker is stopped. A subsequent invocation also removes a stale
partial before writing. **Callers must serialize invocations targeting the same
output path** (the ingestion CLI's exclusive lock provides this guarantee).
An interrupted parse never replaces the final output.

### Local runtimes

The scripts honor `JAVA_HOME`; otherwise they detect `.tools/jdk*/Contents/Home`
(macOS) or `.tools/jdk*` (Linux). They use `.tools/apache-maven-3.9.9/bin/mvn`
when present, otherwise `mvn` on PATH. Maven artifacts are cached under
`.tools/m2`, not the user's global Maven repository. Native Snappy extraction is
directed to `worker/.runtime`.

This checkout was built with a portable Adoptium Temurin 17 **macOS ARM64** JDK
and Maven 3.9.9 installed beneath `.tools`. No OS packages, shell profiles, or
global configuration were changed. These binaries are not portable to another
OS/architecture and should not be committed. On another machine, provide Java
17+ and Maven or install the matching portable distributions beneath `.tools`.
Official distribution sources:

- [Adoptium downloads](https://adoptium.net/temurin/releases/?version=17)
- [Maven 3.9.9 distribution](https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/)

## JSON contract

One UTF-8 JSON object:

```text
{
  schemaVersion: 1,
  matchId: string | null,
  matchStartTime: number | null,
  patch: string | null,
  parser: { name: "clarity", version: "4.0.1" },
  coordinateSystem: "dota-world",
  sampleInterval: number,
  frames: [{
    time: number,
    heroes: [{
      id: string, name: string, team: "radiant" | "dire", level: number | null,
      x: number | null, y: number | null,
      hp: number | null, maxHp: number | null,
      mana: number | null, maxMana: number | null, alive: boolean | null,
      abilities: [{ name: string, level: number | null, cooldown: number | null }],
      items: [{ name: string, charges: number | null, cooldown: number | null }],
      effects: string[] | null
    }],
    towers: [{
      id: string, name: string, team: "radiant" | "dire",
      x: number | null, y: number | null, z: number | null,
      hp: number | null, maxHp: number | null, alive: boolean | null
    }],
    trees: [{ id: string, x: number | null, y: number | null,
              z: number | null, alive: boolean | null }] | null
  }],
  events: [{
    time: number, type: "death" | "damage" | "ability" | "item" | "modifier",
    actorId: string | null, targetId: string | null,
    ability: string | null, value: number | null, description: string
  }],
  limitations: string[],
  mapContext: {
    towerSource: string, treeSource: string,
    treeCoverage: "all" | "temporary-only" | "unavailable",
    terrainSource: string | null, limitations: string[]
  }
}
```

### Clocks and coordinates

- **All output times use demo tick × Clarity's advertised tick interval**, in
  seconds from replay start. They are not game clock seconds since the horn.
  The first hero frame can be several minutes into the replay after drafting.
- Combat events use their replay *delivery tick*, never the combat-log game
  timestamp. Combat messages can be batched, so their positions on the timeline
  may lag the action. Deaths instead use the actual entity life-state transition
  tick. This deliberately avoids mixing the two clock origins.
- World X/Y use `CBodyComponent.m_cellX/Y * 128 + m_vecX/Y - 16384`.
  These are world units centered on the map, not OpenDota's 0–256 minimap cells.
  No map bounds are clamped and the map's changing size is not inferred.
- **Cooldown encoding changes across builds.** The historical replay stores an
  absolute deadline in `m_fCooldown`; the recent replay stores a duration that
  counts down. The worker observes successive positive values to establish the
  encoding: a decrease matching elapsed time identifies a countdown, while a
  stationary value beyond the current server clock identifies a deadline.
  Before this evidence exists, positive values are null rather than guessed.
  The detected encoding is included in `limitations`.
- Deadline cooldowns belong to the *server game clock*, not the output replay
  clock. The worker subtracts `m_pGameRules.m_fGameTime` when available; otherwise
  it uses `CNETMsg_Tick.tick`, total paused ticks and pause-start tick to
  reconstruct that clock using the advertised tick interval. Missing clock
  data yields null for a deadline. Observed zero/reset and observed expired
  deadlines yield zero. Countdown cooldowns use the directly observed duration.

### Entity provenance and missing data

- Heroes are real `CDOTA_Unit_Hero_*` entities on team 2 or 3. PlayerResource's
  `m_vecPlayerTeamData.NNNN.m_hSelectedHero` is authoritative when available.
  Illusion, replication, and clone flags exclude known copies; nonselected
  entities of a player with a resolved primary hero are excluded. This removes
  ordinary illusions, Meepo copies, and Tempest Doubles where determinable.
  Heroes are not restricted to hard-coded player slots 0–9.
- IDs and names come from the `EntityNames` string table using
  `m_pEntity.m_nameStringTableIndex` or the older `m_nameStringableIndex`.
  Normally these are canonical `npc_dota_hero_*` names matching combat logs.
  If unavailable, the network class is emitted and a limitation is recorded.
  Combat names cannot always distinguish clones from their primary hero.
  Combat illusion flags prevent assigning illusion events the real hero's ID.
- HP, max HP, mana, max mana, and alive are observations of `m_iHealth`,
  `m_iMaxHealth`, `m_flMana`, `m_flMaxMana`, and `m_lifeState`.
  Dead/dying means `m_lifeState != 0`. Missing is null, not zero or false.
- Hero `level` is the observed nonnegative integer `m_iCurrentLevel` on the actual
  hero entity. It is **not** the `m_iLevel` of an ability, an inferred level from
  XP, or a zero default. **An actually observed zero remains zero**; an absent,
  negative, fractional, or nonfinite value is represented as null.
- Deaths are observed **every tick**, independent of sampling, and emitted only
  for an observed alive→dying/dead transition of a real hero. Initial dead
  snapshots and repeated dead states are not deaths. Reincarnation transitions
  are included. Combat-log death messages are deliberately not double-counted.
  Death actor/ability/value are null: killer attribution is not reconstructed.
- Ability slots 0–39 use `m_hAbilities` or `m_vecAbilities`; inventory slots 0–18
  use `m_hItems`, including resolved backpack/stash/neutral slots. Handles are
  resolved with `Entities.getByHandle`, which validates **index and serial**;
  they are never treated as plain entity indices.
- Levels use `m_iLevel`, charges use `m_iCurrentCharges`, cooldowns use
  `m_fCooldown`. Slot names come from `EntityNames`, or a clearly reported
  network-class fallback. Missing slots/handles are omitted, not invented.
  Secondary charges and slot positions are not represented in this contract.
- Modifier **events** come from combat logs, but active modifier snapshots are
  not reconstructed (`effects: null`).
- Match ID comes from `Clarity.infoForFile`'s Dota summary, with observed
  `m_pGameRules.m_unMatchID64` as fallback. Patch is null: no semantic patch label
  is available through these fields; a build number is not a patch label.
- `matchStartTime` is **null**. Bounded inspection of Clarity 4.0.1/protobuf 6.1
  found `CDotaGameInfo.end_time`, but no reliable Unix match-start field in the
  summary or header. `playback_time` is replay duration, and `server_start_tick`
  is a server tick—not a Unix epoch. Neither download time nor filesystem time
  establishes when a match started. Subtracting replay duration from an end
  timestamp would mix drafting/pregame/postgame and match-clock boundaries, so
  the worker does not attempt that inference.
- **180-day publication policy belongs to ingestion:** resolve a verified
  actual match-start Unix timestamp (for example OpenDota `start_time` using
  the observed `matchId`), and reject unknown or older-than-180-day matches.
  Successfully parsing a local replay is not a freshness certificate.
- Frames are streamed to disk/stdout; they are not retained in heap. Up to
  200,000 non-death hero-related combat events and 20,000 deaths are retained and
  sorted. Reaching a cap is reported in `limitations`. All events before the
  cap are preserved; no random sampling is used.
- Unsupported/corrupt/truncated replays fail nonzero instead of returning a
  fabricated replay. No hero frames is also a failure. A readable but unknown
  coordinate schema reports missing positions as null with a limitation.

### Observed map context

The map-context extension keeps `schemaVersion: 1`; downstream cache versions
must distinguish outputs generated before this extension. Older raw files may
omit `towers`, `trees`, or `mapContext`.

- **Towers:** actual `CDOTA_BaseNPC_Tower` entities, filtered by observed team
  2/3. IDs are `tower:<full-entity-handle>` (including serial), not guessed lane
  labels. Names are replay string-table names such as
  `dota_goodguys_tower1_mid`. X/Y/Z use the same cell-coordinate decoding as
  heroes. HP/max HP/life state use observed network properties.
- Tower state is updated every tick. Snapshots retain destroyed towers and their
  last observed coordinates/HP after deletion. A deletion alone does **not**
  prove destruction: `alive` becomes null unless death/zero HP was observed.
  Missing properties remain null until a value has actually been observed.
- **Trees:** actual `CDOTA_TempTree` network entities with observed X/Y are
  included. Their creation/presence is standing (`alive: true`); their actual
  entity deletion is removal (`alive: false`). Available life-state properties
  take precedence. Observed removed-tree snapshots are retained; consumers
  should not draw records with `alive: false` as standing trees.
- Both tested current replays expose only `CDOTA_TempTree` as a tree-related
  network entity class. They do **not** supply an initial permanent forest
  layout through these entities. Permanent tree placement, cuts and regrowth
  are not reconstructed. Combat-log tree-cut messages alone do not establish a
  complete initial tree population and are not turned into invented trees.
- Consequently `mapContext.treeCoverage` is **`temporary-only`** when positioned
  temporary trees were observed, otherwise **`unavailable`**. `trees` is null
  before any supported positioned tree is observed. There is no claim of full
  permanent-tree coverage.
- **Terrain is unavailable:** `terrainSource: null`. Observed tower/tree Z is
  an object's elevation, not a terrain mesh or evidence of a cliff/ramp
  boundary. No height map, forest, ramp, river, or static terrain geometry is
  fabricated.

Actual map verification:

| Replay | Towers in every frame | Observed destroyed towers | Temporary trees |
| --- | ---: | ---: | ---: |
| 9009355617 | 22 | 3 | 3, all observed created and removed |
| 9009344330 | 22 | 13 | 4, all observed created and removed |

All tower/tree positions had observed X/Y/Z. Tower HP changes and alive→dead
transitions were verified in the actual outputs. Property inspection is
available in ignored `worker/map-properties.txt`; normalized map-enabled
outputs are `worker/recent-map.json` and `worker/second-map.json`.

## Verification and upstream references

`worker/build.sh` runs seventeen unit tests covering world coordinates, handle
sentinels, real cooldown/null semantics, life-state transitions, illusion IDs,
finite values, explicit JSON nulls, and old/new cooldown encoding detection
(including pauses and slow sampling), deterministic timeout-cleanup paths,
observed tower destruction versus uncertain deletion, map-context nulls, and
nonnegative observed hero levels (including zero) versus unknown values.

End-to-end verified with the public OpenDota fixture
[`1781962623_1.dem`](https://odota.github.io/testfiles/1781962623_1.dem):
10,087 sampled frames, all 10 canonical heroes, 20,828 combat events, and 81
real-hero life-state deaths. All 99,135 hero snapshots had observed position,
health, max health, mana, and max mana. Positive cooldowns were observed for
both abilities and items. Fixture files/output/property dumps are untracked
diagnostic artifacts, not bundled game data.

Also verified the separately acquired recent replay **9009355617**: 4,286
frames, exactly 10 canonical heroes per frame, 7,861 combat events and 22
real-hero deaths. Every one of its 42,860 hero snapshots had observed position,
HP/max HP and mana/max mana. This replay revealed and regression-tested the
remaining-duration cooldown encoding; its actual property values, rather than
a patch-number guess, determine interpretation. These fixtures do not prove
compatibility with every future Dota build.

A second independently acquired recent replay, **9009344330**, also passes:
8,760 frames, all 10 heroes, 27,549 combat events, and 92 observed real-hero
deaths. Its Chaos Knight and Phantom Lancer illusions do not introduce
duplicate hero IDs into the frames.

The level/match-start extension was verified only on those two current replays,
without reparsing the historical fixture. Cache-v3-ready outputs are
`worker/recent-v3.json` and `worker/second-v3.json`; both retain tower/tree
context. Every hero snapshot had an observed level:

| Replay | Observed hero level range | Observed increasing-level transitions |
| --- | ---: | ---: |
| 9009355617 | 1–11 | 69 across all 10 heroes |
| 9009344330 | 1–28 | 167 across all 10 heroes |

Match 9009355617's actual summary has `end_time: 1789982057` and
`playback_time: 1197.0001`, but **no verified start epoch**. These are retained
as diagnostic evidence in ignored `worker/level-properties.txt`, not
misrepresented as `matchStartTime`. Both outputs emit `matchStartTime: null`
with an explicit provenance limitation.

Implementation grounded in:

- [Clarity API/source](https://github.com/skadistats/clarity)
- [Clarity position example](https://github.com/skadistats/clarity-examples/tree/master/src/main/java/skadistats/clarity/examples/position)
- [Clarity cooldown example](https://github.com/skadistats/clarity-examples/tree/master/src/main/java/skadistats/clarity/examples/cooldowns)
- [OpenDota parser](https://github.com/odota/parser/blob/master/src/main/java/opendota/Parse.java)

`--inspect` writes the observed properties of the first encountered hero,
ability, and item entity of each network class. Use this to investigate future
schema drift; it is separate from stdout and is not uploaded anywhere.
