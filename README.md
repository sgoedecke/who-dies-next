# Who dies next?

An unofficial, noncommercial Dota 2 fan puzzle. Inspect a frozen encounter,
choose who dies first, then watch the **recorded** ten-second continuation.
This is a lightweight 2D browser view, not a Dota renderer or simulator.

- App: **https://sgoedecke.github.io/who-dies-next/**
- Repository: **https://github.com/sgoedecke/who-dies-next**
- **187 real snippets from 48 recent pro and high-rank matches**, up to five
  relevant heroes per snippet and five snippets per match, chosen by a drama
  score (upsets, close calls, trades, crowded fights) from 400+ candidates.
- Daily: everyone gets the same five clips each day, turning over at local
  midnight, ordered from easiest to hardest. Guess, watch, then move on to the
  next clip. At the end, a results page shows your score and a **Copy result**
  button that copies a five-square emoji summary and a link. The day's clips
  are dealt from seeded shuffles of five difficulty tiers, so no clip repeats
  until all have been used.

The exact recorded hero coordinates are preserved. A tight stable camera,
readable portraits and collision-separated callouts keep encounters inspectable.
The bottom-right minimap uses the same world crop. Hero/skill levels, resources,
items and cooldowns follow observed samples; unavailable values remain unknown.

The verdict is held back until the answer's recorded death plays, so the clip
isn't spoiled. Movement trails, attack lines, cast icons, damage numbers and
death bursts are all derived from recorded frames and events; nothing is
simulated. The event feed lists casts, spell damage and deaths, and leaves out
auto-attacks, modifiers and courier actions. Progress for the day
is kept in `localStorage`, so a reload resumes where you left off.

## Run locally

Node 22.12+ is required; CI uses Node 24. Playing the app requires **no Java,
Steam client, credentials or backend service**.

```sh
npm ci
npm run dev -- --port 5187 --strictPort
npm test
npm run build
```

Open http://127.0.0.1:5187.

## GitHub Pages deployment

The Pages workflow builds the static site under `/who-dies-next/`, audits the
tracked files and generated artifact, and deploys `dist/`. Push an audited commit
to `main` or dispatch **Deploy GitHub Pages** in Actions. Repository Pages
settings must use **GitHub Actions** as the source.

```sh
VITE_BASE_PATH=/who-dies-next/ npm run build
npm run preview -- --port 4173 --strictPort
# Open http://localhost:4173/who-dies-next/
npm run audit:publish
```

All scenario, icon-manifest, image and terrain requests resolve against Vite's
base URL. Local development defaults to `/`.

Publication uses an explicit source/artifact allowlist. Credentials, private
profiles, raw replays, depot files, local tools/runtimes, `node_modules`, logs,
screenshots and caches are never part of the repository or Pages artifact.
The audit inspects exact git-index bytes and verifies that built public data
matches them. It rejects private-path/token patterns, unexpected files and
catalog/file mismatches in the published corpus.

## Refresh the replay corpus

The working acquisition and generation procedure, tested commands, bounds,
provenance and measured results are in **[SCRAPE.md](SCRAPE.md)**.

```sh
npm run worker:build
npm run corpus -- --source pro --new 20   # rescans the cache, adds 20 new matches
npm run map:extract       # only with the authorized cached client assets
npm run assets:prepare -- --source .cache/asset-backups/<hash>/assets
npm test
VITE_BASE_PATH=/who-dies-next/ npm run build
# Stage only intended source, snippets and required assets; inspect the list.
npm run audit:publish
```

Ingestion is an offline maintenance tool, not a service deployed to Pages.
It uses legitimate public match discovery and downloads actual `.dem` files,
decompresses them and parses them locally with Java Clarity 4.0.1.
OpenDota supplies acquisition metadata, **not** reconstructed gameplay.
Java 17+, Maven and the relevant decompressor are needed only for this step;
see [worker/README.md](worker/README.md).

Every playable match must have an actual verified start timestamp within
**180 days**. Unknown, future and stale dates are rejected; caches and file
download dates cannot waive this restriction. The published corpus eventually
expires unless maintained. The browser reports missing/invalid data explicitly
and never substitutes a demo.

## Data limits and provenance

- Outcomes are observed first deaths, not optimal-play or escape simulations.
  Complete relevant participants are included; encounters with more than five
  heroes or excessively spread trajectories are rejected, never truncated.
- Actual sampled states/events determine playback. Interpolation is visual;
  it does not simulate vision, pathing, projectiles, creeps or counterfactuals.
- The qualified current-client map reference contains 2,475 tree origins and
  80,726 collision-checked height samples. Missing cells stay unknown.
  All 22 tower anchors were checked separately for each of the 48 exact replay
  hashes; recency alone does not establish compatible geometry.
- Permanent-tree cut/regrowth state and exact replay server builds remain
  unknown. The reference is not a live obstruction or vision model.
- The public image bundle is restricted to this app's actual corpus needs,
  not a general-purpose mirror or asset pack.

See [scenario format](docs/scenario-format.md),
[map context](docs/map-context.md), [map acquisition](docs/map-assets.md), and
[asset provenance](docs/assets.md).

## Rights and attribution

Not affiliated with or endorsed by Valve Corporation. Dota, its artwork and
associated game content belong to Valve and/or their respective owners.
This free fan application incorporates Valve content on a **noncommercial**
basis under the fan-art permission in the
[Steam Subscriber Agreement, section 2.D](https://store.steampowered.com/subscriber_agreement/?l=english).
That is not a license to redistribute assets separately or use them commercially.

**No blanket project license grants rights in Valve images, Valve-derived map
data, gameplay content or third-party metadata.** See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the scope, limitations,
upstream notices and the OpenDota MIT license.
