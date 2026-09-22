# Replay map context and terrain compatibility

## What the prototype may render

Observed towers and tree entities use the same replay clock, world coordinates
and world-to-screen transform as heroes. Initial HP/alive/dead state comes from
the frozen source frame, not from the end of the match. Continuation updates
appear only after guessing and advancing the timeline. The entire encounter
uses one stable frame derived from hero trajectories, nearby observed towers,
and a margin.

Replay-layer metadata is stored in `mapContext`; provenance and limitations are
documented here and in the datasets, with directly relevant marker tooltips.
The game intentionally has no Info or Map panels.
Only a real entity observation can create a replay tower or temporary-tree marker. Absence of a
tree marker is **not evidence of clear ground**. Temporary-tree coverage does
not establish the initial permanent forest. Entity Z, especially a flying
hero's Z, is never converted into a terrain-height claim.

A separate, explicitly qualified **current-client reference layer** now supplies
collision-height samples and base permanent-tree positions. These are extracted
from the current Valve client map, not inferred from replay heroes. Base trees
have unknown current life state and must remain visually distinct from observed
temporary trees.

The prototype does not simulate line of sight, pathing, attack range, tree
collision, or traversability. A coordinate-aligned layer is not a replacement
for those missing game systems.

### Verified current replay observations

Clarity recovered 22 `CDOTA_BaseNPC_Tower` entities in each replay, including
actual XYZ, HP and life state. Match `9009355617` contains three observed tower
destructions and three `CDOTA_TempTree` lifecycles; match `9009344330` contains
13 tower destructions and four temporary-tree lifecycles. No permanent-tree
network population was recovered. Deletion of a temporary tree means observed
removal, not proof of which ability destroyed it.

Historical example `replay-9009355617-610500` shows a temporary tree absent at the
start, present at `+4.266625s`, and removed at `+4.5s`. Historical example
`replay-9009344330-1442767` shows a tower alive at 1,431 HP at the start and
destroyed at `+7.233375s`. Restarting returns to the actual initial observation.
Both examples were archived by the strict four-hero/compact-trajectory policy;
they are no longer published puzzles. Current snippets retain nearby observed
tower state without letting those towers expand the hero-only camera.

## Current-client reference layer

`public/maps/dota-6934.json` is a 237,758-byte versioned dataset generated with
`npm run map:extract` from an authorized exact-file acquisition. It contains:

- 2,475 actual `ent_dota_tree` XYZ origins across all five map entity layers.
- An 87,616-cell elevation grid at 64-world-unit cell centres, RLE-compressed
  by row; 80,726 heights are collision-checked and 6,890 remain explicitly null.
- Manifest/build/compile dates and archive/resource SHA-256 fingerprints.
- Per-replay alignment evidence for **all 22 named towers**, including XYZ.

Client/server version is **6934**, SourceRevision **11015183**; the authoritative
manifest is dated 2026-09-18 and this actual map compiled at
2026-09-01T23:00:07Z. All eleven corpus matches align within 0.016 world units in XY and
0.032 vertically. The browser permits this reference only for the checked
match IDs **and exact replay hashes**, while both match and client dates remain
eligible. It does not assume every replay in the last 180 days shares this map.
**Exact replay server builds are unknown**: matching tower anchors support
coordinate alignment, not identity of every tree, cliff or ramp.

Heights come from the actual `maps/dota.vhcg` height-collision resource. Its
version-specific binary layout was structurally validated against the entire
file and checked against all 22 client tower origins (maximum height discrepancy
0.000244 world units). This is not an official Valve format specification.
The auxiliary float channel remains uninterpreted. Actual height changes are
sampled, not decorative guessed polygons: 64-unit cells and integer-rounded
heights approximate slopes and sharp elevation changes, not exact cliff/ramp
boundaries. Collision surfaces can include non-traversable fixed geometry;
they do not establish walkability or vision.

Every published height, including non-flat detailed samples, was independently
compared with an actual default-world collision triangle at the same XY, within
eight vertical units. Of 81,862 non-null candidates, 1,136 did not meet this check
and were masked to null. Publication fails if fewer than 95% match; the schema
checks the recorded counts against the non-null output. This is a conservative
surface cross-check, not a claim of exact engine interpolation or traversability.

Base tree positions do **not** establish which trees are still standing at the
scenario start. Permanent-tree destruction/regrowth is not recovered. The compact
TRM resource also has eight additional XY positions plus one duplicate that are
not represented as verified tree entities. These limitations are retained in
the dataset, documentation and marker tooltips; base markers are not collision/escape promises.
Observed replay temporary-tree/tower changes remain separate and take precedence
as actual time-indexed observations.

See [map-assets.md](map-assets.md) for acquisition, cleanup, exact hashes, format
evidence and reproducible extraction commands.

## Why older public map layers were rejected

Research on 2026-09-21 found no public static terrain dataset verified against
the current replay build. There is affirmative evidence that the most
convenient older sources are incompatible:

| Source | What exists | Compatibility finding |
| --- | --- | --- |
| [OpenDota patch constants](https://github.com/odota/dotaconstants/blob/b72f23e1ab2b64f54cc063250a44646d6d692303/build/patch.json) | Provider patch ID 60 maps to major version 7.41 | Identifies major patch from provider metadata, not exact replay build/letter patch |
| [OpenDota map viewer](https://github.com/odota/web/blob/master/src/components/DotaMap/DotaMap.tsx) | Latest background `detailed_740`; date-based image selection | Image only, not a height grid; 7.40 predates relevant terrain changes |
| [Valve official 7.41 patch notes](https://www.dota2.com/datafeed/patchnotes?version=7.41&language=english) | Structured terrain-change descriptions | Ground levels, Twin Gate stairs, Radiant tier-one ramp, towers and trees changed |
| [Devilesk elevation dataset](https://raw.githubusercontent.com/devilesk/dota-interactive-map/master/assets/data/723/elevation.json) | Actual elevation polygons | Version 7.23, commit `f2ea30fe2e7dbe2b607facfa7b428e2e057746ed`, dated 2019-11-29 |
| [Devilesk initial map data](https://raw.githubusercontent.com/devilesk/dota-interactive-map/master/assets/data/723/mapdata.json) | 2,102 initial tree coordinates and other map data | Also 7.23; cannot establish a current forest |
| [SteamDatabase game tracking](https://github.com/SteamDatabase/GameTracking-Dota2) | Recent build metadata | No usable current world-height/navmesh dataset found in the bounded investigation |

Using a 7.40 minimap as accurate 7.41 geometry would therefore be misleading.
No old terrain image, tree dataset or speculative ramp polygon is bundled or
silently enabled. The new reference layer comes from the recent client itself;
unchecked replays still have no verified static map layer.

The old exporter is a useful engineering reference, not current data:
[dota-map-coordinates](https://github.com/devilesk/dota-map-coordinates) used
actual `GetGroundHeight` calls and entity `GetOrigin`, with a 64-world-unit grid
origin at `(-8288, -8288)` and flipped image Y. Some exports quantized height.
Its coordinate scheme does not establish the origin/extent of a later map.

## Requirements for refreshing the reference layer

A refreshed authorized current-map export must carry exact map/build provenance,
origin, grid spacing, axis orientation, height semantics, and initial-tree
coverage. Ramps need actual sampled/interpretable height transitions rather
than arbitrary visual decoration. Tree destruction/regrowth needs timestamped
observations or replay-supported deltas, not present-day final state.

Acquisition must remain authorized, bounded and reproducible. The implemented
workflow downloads only three exact manifest-verified files, not the full depot,
and requires the user to personally approve Steam Mobile QR sign-in. It does not
request passwords, bypass access checks or fetch client assets from unofficial
mirrors. A new archive/layout requires deliberate validation: the current
extractor rejects unknown archive hashes, template transforms and VHCG layouts
rather than silently publishing guessed geometry.
