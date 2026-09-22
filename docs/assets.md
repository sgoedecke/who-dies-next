# App-specific local Dota assets

The deployed app contains only the artwork referenced by its bundled real replay
snippets, not a general-purpose Dota asset catalog. Full local catalogs and
metadata backups stay under `.cache/` and must not be published.

Prepare the current corpus entirely offline, then check it:

```sh
npm exec -- tsx scripts/prepare-public-assets.ts
npm exec -- tsx scripts/prepare-public-assets.ts --check
```

Preparation reads every hero, inventory item and ability in **every frame** and
the start snapshot, plus question/event references. It uses the same exact
resolvers as the app, retains both portraits and minimap icons for referenced
heroes, and preserves aliases, definition IDs, labels, URLs, checksums, missing
records and referenced unsupported talents. Shared recipe PNGs are retained once.
It does not choose replacement artwork or invent gameplay telemetry.

Before pruning, the complete existing `public/assets` tree is copied and
SHA-256-verified at `.cache/asset-backups/<tree-sha256>/assets`. The command refuses
to prune if a backup, retained image or resolver-equivalence check fails.
Unneeded PNGs and all raw metadata catalogs are removed from `public/assets`.
Only the manifest and referenced PNG files are shipped; needed metadata is
already represented by manifest fields and pinned provenance URLs.

`.cache/public-assets-report.json` records exact counts, unknown references,
backup location and the output-tree checksum. The manifest's additive `bundle`
field records the original source-manifest hash, hashes of the exact scenario
catalog and clips, attribution and app-specific scope. Existing consumers can
ignore this field. Neither raw replay/Steam-client data nor credentials are
included in the asset bundle.

The check command performs no downloads or public-file changes. It verifies all
PNG signatures/hashes and that the published file set is exactly the referenced
set plus `manifest.json`. To compare the result against the original full
catalog, pass its backup path:

```sh
npm exec -- tsx scripts/prepare-public-assets.ts --check --source .cache/asset-backups/<tree-sha256>/assets
```

For a changed corpus, prepare again using an existing complete private catalog:

```sh
npm exec -- tsx scripts/prepare-public-assets.ts --source .cache/asset-backups/<tree-sha256>/assets
```

No full catalog is required for an unchanged checked-in corpus. Repeated runs on
identical inputs produce byte-identical manifests and PNGs. A pruning-induced
alias ambiguity change fails closed rather than turning an unknown into a false
match. Paths are allowlisted beneath `public/assets`; traversal, encoded paths,
symlinks and external source directories are refused. Only explicitly inventoried
files are deleted, never the asset root or another public directory.

**Clean-checkout CI:** `npm run assets:prepare -- --check` uses only the published
manifest, its PNG files, and the 50 scenario files/index. It does not read backups,
full catalogs, or network sources; absent `.cache` is supported (a transient lock
directory is created automatically). The clean-checkout test copies only those
public inputs into a new project root and prohibits network access. Passing an
original backup via `--source` additionally compares resolution results against
that full catalog; it is optional and is not a CI dependency.

## Optional private catalog refresh

This is a separate network operation, **not** part of preparation:

```sh
npm exec -- tsx scripts/fetch-assets.ts
npm exec -- tsx scripts/prepare-public-assets.ts --source .cache/asset-catalog/assets
```

The fetcher now writes **only** to `.cache/asset-catalog/assets`, never directly
to `public`. It reads the current `odota/dotaconstants` master revision, pins its commit
SHA, and fetches `build/heroes.json`, `build/items.json`, `build/item_ids.json`,
`build/hero_abilities.json`, `build/abilities.json`, and `build/ability_ids.json`
from that same revision. These maintained OpenDota metadata files describe Dota
definitions; they are not a promise that every historical/unused definition has
a currently published icon. The union of item metadata and item IDs is retained,
including neutral items, recipes, upgrades, obsolete entries and unused variants.
IDs are actual definition IDs, never generated sequence numbers.

All image bytes come directly from Valve's public Steam CDN:
`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/`.
Hero portraits use `heroes/{internal}.png`, hero minimap icons use
`heroes/icons/{internal}.png`, item images use `items/{internal}.png`, and ability
images use `abilities/{internal}.png`.
Metadata image paths take precedence. For example, recipes explicitly mapped
to `items/recipe.png` by metadata share one downloaded file; their individual
manifest entries contain `imageAlias` with the metadata source and reason.
An ID-only recipe without such evidence is attempted at its own URL and stays
missing if unavailable; a generic recipe image is never silently substituted.

## Files and consumer contract

- `public/assets/manifest.json`: served at `/assets/manifest.json`; exact pinned
  sources, timestamp, per-definition status, aliases, path or `null`, image URL,
  byte size, SHA-256, counts and explicit missing entries/errors.
- `public/assets/heroes/*.png`: portraits.
- `public/assets/heroes/icons/*.png`: minimap icons.
- `public/assets/items/*.png`: distinct item/recipe images.
- `public/assets/abilities/*.png`: actual ability icons, including passive and
  innate abilities.
- Full source snapshots are private in the backup or
  `.cache/asset-catalog/assets/catalog/`, not under `public`.

`shared/assets.ts` exports `Asset`, `AssetManifest`, `resolveHeroAsset` and
`resolveItemAsset`, and `resolveAbilityAsset`. Hero keys are canonical `npc_dota_hero_*` names; item keys
are canonical `item_*` names. Resolvers accept stable definition IDs, canonical
names, internal names, normalized human labels and explicit aliases. They do
not guess fuzzy matches or conflate numbered variants. Ambiguous aliases return
`null`. Missing definitions still resolve to their entry, with `status: "missing"`
and `path: null`, so consumers must check the path/status before rendering.
An unrecognized name or absent manifest returns `null`.

Each hero's main image is its portrait; the optional `icon` field independently
reports the minimap icon's URL, local path and status. Item IDs are typed as
`number | null` to represent absent metadata honestly, although `item_ids.json`
normally supplies them. UI consumers should use local paths, not hotlink URLs.

Ability keys are canonical internal names such as `mirana_arrow`. The private
source catalog includes the union of all non-talent abilities in `abilities.json`,
`ability_ids.json`, and the current `hero_abilities.json` references. This is a
superset of current hero abilities, retaining innate/passive, sub-ability,
legacy, neutral-creep, and world/NPC definitions rather than assuming only four
active spells per hero. The public manifest retains only actual clip references.
Ability IDs come from `ability_ids.json` (or remain
`null` when not supplied). If the source supplies multiple IDs for one name,
the manifest keeps `id: null` rather than guessing which is current, and
preserves every source ID as an explicit resolver alias. Names beginning
`special_bonus` are talents/stat
bonuses without promised unique icons; these are deliberately not requested and
are explicitly listed in `unsupported`, counted by
`summary.unsupportedAbilities`, not reported as successful downloads. No generic
talent graphic is presented as a distinct spell icon. `summary.abilities` and
`missing` report every attempted ability icon separately. The manifest stores
artwork, not gameplay telemetry: cooldowns, levels, mana costs, ability readiness
and replay visibility are never invented from image metadata.
Metadata parser artifacts that are not canonical lowercase internal names
(such as `AbilityCastPoint`) are also reported in `unsupported`, with a distinct
reason, rather than fetched or invented as abilities.

## Reliability and truthful failure reporting

At most six image requests run concurrently. Each attempt has a 20-second
deadline and a 4 MiB image / 8 MiB metadata limit enforced both on Content-Length
and streamed bytes. Network errors, HTTP 429 and server failures have at most two
retries; permanent 4xx and invalid images are not retried. Redirects are rejected.
Images require PNG content type, PNG magic, IHDR/dimensions and terminal IEND.
Verified files and the final manifest are written with same-directory atomic
renames. Existing files resume only after PNG and recorded SHA-256 verification;
corrupt files are fetched again. Missing images are retried on the next run.
Metadata retrieval failure leaves the previous catalog intact.

Fetcher exit codes are **0** for a complete catalog, **2** for a completed attempt with
explicit missing images, and **1** for fatal metadata/setup/manifest-write errors.
Code 2 is not a success claim: inspect `summary` and `missing`. Counts distinguish
per-definition images from distinct image files; multiple recipes sharing a
generic image are not claimed as distinct downloads. A refresh does not run
replay ingestion, change replay data, or require a replay parser.
Preparation/check exits **0** when the exact subset is safely preserved,
including known missing records, or **1** on a failed safety/equivalence check.
Preparation does not retry existing missing CDN images.

Dota 2 names, artwork and game assets belong to Valve Corporation. The public
CDN is the source, not a grant of ownership or a claim of endorsement. This
project is unofficial and is not affiliated with Valve or OpenDota. Metadata
source: <https://github.com/odota/dotaconstants>.
This minimal app packaging is not a legal-clearance claim or a standalone
asset-redistribution license. See the repository and deployed
`THIRD_PARTY_NOTICES.md` for the project's separate notices and policy context.

## Verified shipped subset

The September 22, 2026 preparation used the existing local download from
OpenDota revision `c55d9a75389650fdebc07e34e6f748868adf9405`; no downloads occurred.
All **50 real snippets**, **174,285 reference occurrences**, and **1,687 distinct
resolver queries** were checked against the complete source catalog.

| Catalog | Downloaded entries | Missing entries |
| --- | ---: | ---: |
| Hero portraits | 56 | 0 |
| Hero minimap icons | 56 | 0 |
| Item definitions | 131 | 0 |
| Ability definitions | 342 | 34 |

The shipped tree contains **582 distinct PNGs**, **20,087,182 image bytes**, and
one manifest. Four item entries explicitly reuse metadata-specified image names.
All **34** existing missing ability records and **432** referenced unsupported
talents remain explicit. All **619 resolved** and **1,068 unresolved** queries
retain their original results; unresolved queries include event ability/item
fallback probes, not just missing gameplay artwork.

Preparation removed **1,144 unreferenced PNGs** and all **six full metadata JSON
catalogs** from `public`. The original **1,726 PNGs** and original catalogs are
preserved in the verified private backup. All retained PNG paths and hashes are
unchanged. Golden tests cover this shipped subset, later-frame item acquisition,
event references, missing/unsupported states, shared images, path confinement,
checksum failures, backup integrity and reproducibility.
