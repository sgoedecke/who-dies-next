# Recent client-map acquisition and extraction

## Verified outcome on 2026-09-21

No current Dota client map archive was found in the machine's configured Steam
library. Steam itself is installed, but `appmanifest_570.acf` and the expected
`dota 2 beta/game/dota/pak01_dir.vpk` are absent. The library configuration lists
only the default library; no broad home-directory search was performed.

An **actual anonymous manifest-only request** was then made with the official
DepotDownloader 3.4.0 native macOS ARM64 binary. Steam connectivity and anonymous
login both succeeded. The distribution service refused the content depot:

```text
Connecting to Steam3... Done!
Logging anonymously into Steam3... Done!
Got AppInfo for 570
Depot 373301 is not available from this account.
Total downloaded: 0 bytes (0 bytes uncompressed) from 0 depots
```

That anonymous probe obtained no client payload, map archive, account credentials, or full depot.
**This is an observed entitlement blocker, not a guess that a login might be
needed.** The tool itself returns exit code zero in this case, so our wrapper
also checks denial output and the presence of a real manifest. The wrapper
correctly exits nonzero and records `success: false`, `accessDenied: true`.

The user subsequently authorized Steam Mobile QR authentication. An isolated
authenticated run successfully retrieved Valve's content manifest
`693476521428628584`, dated **2026-09-18 22:41:29 UTC**. The temporary credential
profile was removed and its absence verified. Anonymous entitlement denial is
therefore no longer the acquisition blocker; it remains relevant to unattended
anonymous refreshes.

Evidence is preserved locally in the ignored `.cache/terrain/probe.json` and
`.cache/terrain/probe.log`. The probe is capped at 120 seconds plus a five-second
termination grace period and 1 MiB of captured output.

## Reproduce the bounded probe

```sh
npm run map:probe
```

The command deliberately always uses `-manifest-only`, anonymous login, app 570
and the configured exact depot/manifest. It never requests credentials or
downloads the client. Numeric `--depot` and `--manifest` overrides are available
for a separately verified recent build; `--tool` selects an installed
DepotDownloader executable.

The current discovery identifiers were:

| Field | Value |
| --- | --- |
| Public build ID | `25401230` |
| Public build update | `2026-09-18T22:52:09Z` |
| Content depot | `373301` |
| Manifest | `693476521428628584` |
| Tracked ClientVersion / ServerVersion | `6934` |
| Tracked SourceRevision | `11015183` |

Build/depot discovery came from the third-party
[Steam app-info mirror](https://api.steamcmd.net/v1/info/570); tracked build
metadata came from
[SteamDatabase's current steam.inf](https://github.com/SteamDatabase/GameTracking-Dota2/blob/master/game/dota/steam.inf).
These are discovery references, not proof of compatibility with a replay.
The manifest ID/date and exact file entries have now been checked against the
authenticated authoritative content manifest. Downloaded `steam.inf` confirms
ClientVersion/ServerVersion 6934 and SourceRevision 11015183.

The official tool archive is:

https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_3.4.0/DepotDownloader-macos-arm64.zip

It was bounded to 100 MiB while downloading (actual archive 32,245,964 bytes).
The downloaded archive SHA-256 is
`60e80c7c496f3f9a079cd3c62036b35d088c27bc0149baf38f009eb57a52f6a5`.
The fingerprint identifies the downloaded tool; it is not a Valve map checksum.
The installed tool and its license remain under `.tools/depot-downloader/`.
For another OS/architecture, use the matching official release binary and
`npm run map:probe -- --tool /path/to/DepotDownloader`.

## Authorized exact-file acquisition

The authenticated manifest identifies these exact current files:

| File | Bytes | Manifest SHA-1 |
| --- | ---: | --- |
| `game/dota/maps/dota.vpk` | 29,021,488 | `412137a154d86cd4ba61da98692a5fb15e1cb79a` |
| `game/dota/pak01_dir.vpk` | 23,094,048 | `0506193ec92b33952c33e2e83efde2e579cd8def` |
| `game/dota/steam.inf` | 220 | `da9109f20cbac46f2f4469d9cb0b6a9703af89de` |

Total selected payload: **52,115,756 bytes (49.7 MiB)**. The main directory index
does not include its referenced archive chunks; missing external resources must
be reported, not trigger an unrestricted download. Historical maps such as
`dota_683.vpk` are not selected even though the current depot contains them.

The second user-approved QR run **downloaded all three files successfully**.
Each size and manifest SHA-1 matched. Status became `map-files-ready`;
credential cleanup was verified and no scoped auth profiles or auth lock remained.

```sh
# macOS only: non-authenticating actual storage/cleanup verification
npm run map:qr -- --check
# User-scanned QR: authoritative manifest only
npm run map:qr
# Validate manifest and storage without signing in or downloading payload
npm run map:qr -- --download-map --check
# User-scanned QR: only the three manifest-verified files above
npm run map:qr -- --download-map
```

Run QR commands in a visible terminal. Each authenticated run needs the user to
scan and approve in Steam Mobile; no passwords or Steam Guard codes are accepted.
The wrapper creates a private `0700` profile, redirects macOS Foundation/.NET
storage using **`CFFIXED_USER_HOME`**, and first checks actual isolated-store
creation with a non-authenticating `-V` invocation. `HOME`/XDG alone do not isolate
macOS .NET storage. Authentication fails closed if the preflight does not pass.

DepotDownloader saves a refresh token even without `-remember-password`. This
profile is removed at normal exit or cancellation; a fresh QR is needed on the
next run. Hard kill or power loss can interrupt cleanup. Safe status at
`.cache/terrain/qr-status.json` records the profile path and cleanup result for
recovery without reading credentials. Terminal history can retain displayed
text; the wrapper does not capture authentication output or QR screenshots.
The dev server denies access to private `.cache` and `.tools` paths.

Payload mode validates the pinned depot/manifest, a real recent manifest date,
one regular entry per exact path, full checksums and a **100 MiB aggregate cap**.
The exact file list is created/read back inside the private profile before
launch; no regex, wildcard or missing-file-list fallback is allowed.
Downloaded sizes and SHA-1 values must match before status becomes
`map-files-ready`. Both modes have a ten-minute timeout plus termination grace.
Files remain in ignored `.cache/terrain/current-client/`; the downloader and
extractor remain in ignored `.tools/`.

Before downloading payloads, inspect the authoritative manifest for exact paths,
sizes and build dates. Do not run an unrestricted client/depot download. The
full discovered content depot was approximately 3.27 GB and was not downloaded.
Use only recent assets, but **do not assume that being less than 180 days old
makes map geometry interchangeable**.

## Concrete extraction path

[ValveResourceFormat / Source 2 Viewer 20.0](https://github.com/ValveResourceFormat/ValveResourceFormat/releases/tag/20.0)
is a current, MIT-licensed toolchain (release dated 2026-08-17), with a native
macOS ARM64 CLI. It supports VPK listings, entity resources, map/world resources
and physics collision data. Its official native binary has been downloaded and
used successfully on the acquired current map:

```sh
Source2Viewer-CLI -i /absolute/path/to/map.vpk --vpk_list
Source2Viewer-CLI -i /absolute/path/to/map.vpk \
  -o .cache/terrain/extracted \
  --vpk_extensions gnv,vents_c,vwrld_c,vwnod_c,vphys_c,vrman_c
Source2Viewer-CLI -i /absolute/path/to/extracted/entity.vents_c -a
```

The native CLI archive is available at
https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/20.0/cli-macos-arm64.zip
(54,097,964 bytes; downloaded with a 60,000,000-byte bound). The archive contains
the CLI and its two native library dependencies, not client assets.

Source inspection establishes the following constraints:

- VRF's map extraction resolves `world_physics.vrman_c` to actual physics
  aggregates/collision resources. This is a potential ground-geometry source
  once the assets exist, not permission to infer terrain from hero Z.
- Dota `.gnv` is a navigation grid, **not an elevation grid**. Its
  `0xFADEBEAD` header carries cell size, offsets and dimensions; payload bytes
  carry traversability/blocking flags. There is no height field. Raw offsets
  alone do not establish a verified world-to-cell-center transform.
- Permanent-tree extraction must traverse child/template entity lumps and compose
  parent transforms. Reading only top-level `origin` strings can misplace trees
  or miss most of the forest. Current tree classes/instancing must be inspected,
  not guessed from an old map.
- Ground/cliff/ramp sampling must identify genuine ground geometry and distinguish
  props/collision shapes. Height is not a full vision or walkability simulation.
- An exported compact dataset must record source archive hashes, build/map
  identifiers, date provenance, coordinate transform, coverage and compatibility
  evidence before the renderer may treat it as authoritative.
- A base permanent forest alone does not capture replay-specific tree destruction
  or regrowth. That limitation must remain visible even if initial trees become
  available.

## Verified compact extraction

```sh
npm run map:extract
```

The command verifies all three original payloads against the authenticated
manifest, requires the exact inspected archive hash, extracts the necessary
resources using Source2Viewer, traverses the root and all four child layers,
and publishes `public/maps/dota-6934.json`. Unexpected child/template graphs,
missing origin fields, changed binary layouts, incomplete checksums or failed
replay anchor checks are errors, not a fallback to guessed geometry.

| Evidence | Value |
| --- | --- |
| Actual map compile time | `2026-09-01T23:00:07Z` |
| `dota.vpk` SHA-256 | `39aef5c803e8b936646f5f77c6b540c11cb848a6fba7bd7ceebd13b6e2b0705d` |
| `dota.vhcg` SHA-256 | `61fbeb0ed74bf0dbfe5aced76561ee23d56ac4b3c198608aa41a676dd221d024` |
| `dota.trm` SHA-256 (inspected, not used as authoritative forest) | `3c201bf89429a48b92cd82f4febfa7495e3805d0d2db1505c951e95d338c8cff` |
| Extracted permanent tree entity origins | 2,475 |
| Height output | 296 by 296 cells, 64 world units per cell, 13,033 RLE runs |
| Published known / unknown heights | 80,726 / 6,890 of 87,616 cells |
| Published JSON size | 237,758 bytes, including eleven checked replay hashes |
| Client tower height-grid check | 22 anchors, maximum error 0.000244 world units |
| Each replay's named tower alignment | 22 anchors, maximum XY error 0.015845 / Z error 0.031189 |
| Independent world-collision check | 81,862 non-null candidate samples checked; 80,726 within 8 vertical units; 1,136 rejected to null |

The acquired map contains a direct **VHCG height-collision grid**, avoiding the
need to label arbitrary world-physics triangles as terrain. The following is an
independently inspected, version-specific layout, not an official Valve spec:

| Offset / region | Verified current encoding |
| --- | --- |
| 0–11 | `vhcg`, LE version 1, header length 128 |
| 12–23 | LE width 165, height 938, detail side 5 |
| 24–35 | float32 cell size 128, origin X -10752, origin Y -109440 |
| 36–127 | Zero reserved header bytes |
| Cell records | 165×938 row-major records of float32 constant height, auxiliary float32, one-byte detail flag |
| Detail payload | Exactly 9,797 flagged cells × 25 row-major float32 samples, in flagged-cell order |

`-16384` is the absent/constant-unavailable sentinel. Detailed cells carry 5×5
samples over their 128-unit cell; constant cells use their stored height.
The auxiliary channel is deliberately not assigned speculative semantics.
The complete file size is accounted for, flags and heights are validated,
and the grid is checked against actual entity origins. Detail presence comes
from the explicit flag, not the value of the constant field. The same structural
layout was independently corroborated using VRF's
[binary format-test fixture](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/20.0/Tests/Files/test_basic.vhcg);
no geometry from that fixture is used. This does not establish official engine
semantics or engine interpolation rules. Alternative offset and
transposed interpretations were compared: the unshifted row-major layout agrees
within one unit with 2,407 of 2,497 tree/tower origins, and all 22 tower heights
agree within 0.000244. Tree model origins can differ from collision height; this
comparison is supporting evidence, not a reason to alter any tree coordinates.

Flat tower agreement alone cannot establish detailed ramp samples. A subsequent
direct comparison used the actual current map's default world-collision mesh:
140,740 vertices and 288,395 triangles. Of 21,688 non-flat detailed samples with
a collision intersection, 20,819 agreed within eight vertical units using the
unshifted row-major interpretation; the transposed interpretation was materially
worse. Some regions disagree or have no intersection, so those samples are not
silently accepted.

The reproducible publisher now cross-checks **every non-null output sample**,
including flats and slopes, against a real triangle intersection at the same XY.
Only rounded heights within eight vertical units are retained. It rejects 1,136
candidates to null and refuses publication entirely if fewer than 95% agree.
Each published dataset records these counts and tolerance in
`source.heightValidation`; its schema verifies the counts cover exactly the
non-null RLE output. These checks establish sampled surface agreement, not which
surface is walkable or an exact replay-build match.

The output samples cell centres inside the actual map's
`[-9472,9472] × [-9472,9472]` fog bounds, at 64-unit spacing, rounded to one
vertical unit. Samples are taken at actual detailed-grid nodes; no assumption
about the engine's interpolation between those nodes is needed for the output.
Unknown and collision-unmatched samples remain null. This displays sampled collision
elevation, including non-traversable geometry, **not exact cliff/ramp boundaries,
pathing or vision**.

All 2,475 published trees are actual `ent_dota_tree` origins from decoded entity
lumps, including Radiant/Dire base layers. No `point_template` instances were
present. The compact `.trm` file contains 2,484 records: eight extra XY positions
without corresponding verified tree entities and one duplicate are not added
to the published forest. The forest is base reference data, not a claim that
every tree survives at the replay start; destruction/regrowth remains unknown.

All ten currently published corpus match hashes have explicit 22-tower XYZ
compatibility records, rechecked with `npm run map:extract` after acquisition.
Their exact server builds remain unknown, so spatial agreement does not prove
identical geometry everywhere. Other recent matches do not automatically inherit
this layer. See [map-context.md](map-context.md) and [scenario-format.md](scenario-format.md).

No ancient public map, unverified `.fow` file, generic background, or fabricated
height bands are substituted. Original client archives remain ignored local
cache data. This local fan prototype does not grant redistribution rights to
Valve's client assets.
