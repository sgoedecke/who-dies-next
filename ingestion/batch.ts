import { parseArgs } from 'node:util';
import { mkdir, open, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { catalogSchema, scenarioSchema, scenarioArchiveSchema, utcDay, type Catalog, type Scenario } from '../shared/scenario.js';
import { CAMERA_MARGIN, MAX_HERO_SPAN, MAX_SCENARIO_HEROES, MIN_CAMERA_EXTENT } from '../shared/encounter.js';
import { clientMapEligibility, clientMapSchema } from '../shared/client-map.js';
import { matchEligibility, scenarioEligibility } from '../shared/recent.js';
import { atomicJson, exists, readJson } from './files.js';
import { acquireMatch, cachedReplayInputs, discoverMatches, loadReplay, CACHE, OUT, type LoadedReplay } from './replay.js';
import { scanScenarios } from './extract.js';
import { MIN_WINDOW_GAP, seededRandom, selectCorpus, verifyAgainstReplay, verifyArchivedSource, samePuzzleIdentity, windowsConflict, outcomeKey } from './corpus.js';

async function main() {
  const { values } = parseArgs({ options: {
    target: { type: 'string', default: '50' }, seed: { type: 'string', default: 'dotadle-v1' },
    source: { type: 'string', default: 'parsed' }, attempts: { type: 'string', default: '25' },
    'max-new-replays': { type: 'string', default: '12' }, 'max-cached-replays': { type: 'string', default: '20' },
    'max-per-match': { type: 'string', default: '5' },
    offline: { type: 'boolean', default: false }, 'verify-only': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  }, strict: true });
  if (values.help) {
    console.log(`Generate a real, recent replay corpus:
  npm run scrape -- --target 50 [--seed dotadle-v1] [--offline] [--verify-only]
    [--max-per-match 5] [--source parsed|public|pro] [--attempts 25]
    [--max-new-replays 12] [--max-cached-replays 20]

Cached sources first. Download only if needed; at most --attempts candidates and
--max-new-replays download attempts/preparations (failed downloads count too).
All existing network/size/time limits apply.
Unique ten-second first-death clips, at least 15s between starts in a match.
At most five clips per match, including preserved entries and daily pins.
At most four relevant heroes; reject remote/outlier paths, never hide participants.
Excess old entries are archived, not used to bypass the cap. Only real replays are published.
Exit 0: target complete. Exit 2: valid partial corpus. Exit 1: explicit failure.
--verify-only never downloads or modifies scenario/catalog files. See SCRAPE.md.`);
    return;
  }
  const target = Number(values.target), attempts = Number(values.attempts);
  const requestedMaxNew = Number(values['max-new-replays']);
  const maxNew = values.offline || values['verify-only'] ? 0 : requestedMaxNew;
  const maxCached = Number(values['max-cached-replays']), maxPerMatch = Number(values['max-per-match']);
  for (const [name, value, low, high] of [['target', target, 1, 100], ['attempts', attempts, 1, 40], ['max-new-replays', requestedMaxNew, 0, 20], ['max-cached-replays', maxCached, 1, 30], ['max-per-match', maxPerMatch, 1, 5]] as const) {
    if (!Number.isInteger(value) || value < low || value > high) throw new Error(`--${name} must be ${low}-${high}`);
  }
  const discoverySource = values.source;
  if (discoverySource !== 'parsed' && discoverySource !== 'public' && discoverySource !== 'pro') throw new Error('Invalid --source');
  const seed = values.seed!;
  if (!seed.length || seed.length > 128) throw new Error('--seed must contain 1-128 characters');
  await mkdir(CACHE, { recursive: true });
  const lockPath = join(CACHE, 'ingest.lock');
  const lock = await open(lockPath, 'wx').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Ingestion is locked; confirm the other process stopped before removing .cache/ingest.lock');
    throw error;
  });
  await lock.writeFile(String(process.pid));
  const now = Date.now();
  const report: Record<string, unknown> = {
    version: 1, startedAt: new Date(now).toISOString(), status: 'running', target, seed,
    policy: { matchAgeDays: 180, durationSeconds: 10, minimumStartGapSeconds: MIN_WINDOW_GAP, maxPerMatch, maxHeroes: MAX_SCENARIO_HEROES, maxHeroSpan: MAX_HERO_SPAN, cameraMargin: CAMERA_MARGIN, minimumCameraExtent: MIN_CAMERA_EXTENT, source: discoverySource, attempts, maxNewReplays: maxNew, maxCachedReplays: maxCached },
  };
  const reportPath = join(OUT, 'corpus-report.json');
  const historyPath = `.cache/corpus-reports/corpus-${now}.json`;
  const writeReport = async (value: Record<string, unknown>) => {
    const recorded = { ...value, historyPath };
    await atomicJson(reportPath, recorded);
    if (value.status !== 'running') await atomicJson(historyPath, recorded);
  };
  try {
    if (await exists(reportPath)) {
      const previous = z.object({ startedAt: z.iso.datetime(), status: z.string() }).passthrough().parse(await readJson(reportPath));
      const previousPath = join(CACHE, 'corpus-reports', `corpus-${Date.parse(previous.startedAt)}.json`);
      if (!await exists(previousPath)) await atomicJson(previousPath, { ...previous, status: previous.status === 'running' ? 'interrupted' : previous.status });
    }
    const catalog: Catalog = await exists(join(OUT, 'index.json'))
      ? catalogSchema.parse(await readJson(join(OUT, 'index.json'))) : { version: 1, scenarios: [], daily: {} };
    const existing: Scenario[] = [], allPublished: Scenario[] = [], retired: { id: string; reason: string }[] = [];
    for (const entry of catalog.scenarios.filter(entry => entry.kind === 'replay')) {
      if (!/^\/scenarios\/[a-zA-Z0-9_-]+\.json$/.test(entry.path)) throw new Error(`Unsafe scenario path: ${entry.id}`);
      const scenario = scenarioArchiveSchema.parse(await readJson(join('public', entry.path)));
      if (scenario.id !== entry.id || entry.path !== `/scenarios/${scenario.id}.json`) throw new Error(`Catalog identity/path mismatch: ${entry.id}`);
      allPublished.push(scenario);
      const eligible = scenarioEligibility(scenario, now);
      if (!eligible.eligible) { retired.push({ id: entry.id, reason: eligible.message }); continue; }
      if (scenario.source.kind !== 'replay') throw new Error(`Catalog source mismatch: ${entry.id}`);
      const playable = scenarioSchema.safeParse(scenario);
      if (!playable.success) {
        if (values['verify-only']) throw new Error(`Published scenario violates current policy: ${entry.id}`);
        retired.push({ id: entry.id, reason: playable.error.issues.map(issue => issue.message).join('; ') });
        continue;
      }
      existing.push(scenario);
    }
    const candidates: Scenario[] = [];
    const failures: { source: string; error: string }[] = [];
    const sources: { matchId: string; replaySha256: string; matchStartTime: number; frames: number; deathEvents: number; examinedDeaths: number; validCandidates: number; rejected: Record<string, number> }[] = [];
    Object.assign(report, { failures, retired, sources, reused: existing.length, actualPublishedRealCount: allPublished.length });
    const loaders = new Map<string, () => Promise<LoadedReplay>>();
    const regeneratedExisting = new Map<string, Scenario>();
    const publishedById = new Map(allPublished.map(scenario => [scenario.id, scenario]));
    const retiredQuestionIds = new Set(catalog.retiredQuestionIds ?? []);
    const addSource = (loaded: LoadedReplay, reload: () => Promise<LoadedReplay>) => {
      const { source, raw } = loaded;
      if (!source.matchId || !source.matchStartTime) throw new Error('Corpus source requires verified match ID and date');
      if (loaders.has(source.replaySha256)) return;
      const scan = scanScenarios(raw, source, { limit: 10000, minStartGap: 0 });
      const admitted = scan.scenarios.filter(scenario => {
        if (retiredQuestionIds.has(scenario.id)) {
          scan.rejected['retired-question-id'] = (scan.rejected['retired-question-id'] ?? 0) + 1;
          return false;
        }
        const previous = publishedById.get(scenario.id);
        if (!previous || samePuzzleIdentity(previous, scenario)) return true;
        retiredQuestionIds.add(scenario.id);
        scan.rejected['published-question-context-changed'] = (scan.rejected['published-question-context-changed'] ?? 0) + 1;
        return false;
      });
      const refreshed: Scenario[] = [];
      for (const scenario of existing.filter(scenario => scenario.source.kind === 'replay' && scenario.source.replaySha256 === source.replaySha256)) {
        if (values['verify-only']) verifyAgainstReplay(scenario, raw, source, now);
        const replacement = admitted.find(candidate => candidate.id === scenario.id);
        if (!replacement) {
          retired.push({ id: scenario.id, reason: 'Encounter no longer satisfies current participant, framing or stable-question policy' });
          continue;
        }
        verifyArchivedSource(scenario, raw, source, now);
        refreshed.push(replacement);
      }
      for (const scenario of refreshed) regeneratedExisting.set(scenario.id, scenario);
      candidates.push(...admitted);
      loaders.set(source.replaySha256, reload);
      sources.push({
        matchId: source.matchId, replaySha256: source.replaySha256, matchStartTime: source.matchStartTime,
        frames: raw.frames.length, deathEvents: raw.events.filter(event => event.type === 'death').length,
        examinedDeaths: scan.examinedDeaths, validCandidates: admitted.length, rejected: scan.rejected,
      });
    };
    let cacheLoads = 0, networkAttempts = 0, newlyPrepared = 0, downloadAttempts = 0;
    for (const input of (await cachedReplayInputs(Boolean(values.offline || values['verify-only']))).slice(0, maxCached)) {
      try { addSource(await input.load(), input.load); cacheLoads++; }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ source: input.key, error: message }); console.error(`Cached source rejected: ${message}`);
      }
    }
    const priorityIds = [catalog.daily[utcDay(new Date(now))]].filter((id): id is string => Boolean(id));
    const verifiedExisting = () => [...regeneratedExisting.values()];
    let selection = selectCorpus(candidates, verifiedExisting(), target, seed, maxPerMatch, priorityIds);
    await writeReport({ ...report, cacheLoads, available: selection.selected.length, failures, retired });
    if (selection.selected.length < target && maxNew > 0) {
      const missingPublished = [...new Set(existing.filter(scenario => scenario.source.kind === 'replay' && !loaders.has(scenario.source.replaySha256))
        .map(scenario => scenario.source.matchId).filter((id): id is string => id !== null))];
      const remainingAttempts = Math.max(0, attempts - missingPublished.length);
      const discovered = remainingAttempts ? await discoverMatches(discoverySource, remainingAttempts, seededRandom(seed)) : [];
      for (const matchId of [...new Set([...missingPublished, ...discovered])].slice(0, attempts)) {
        if (selection.selected.length >= target || newlyPrepared >= maxNew || downloadAttempts >= maxNew) break;
        if (sources.some(source => source.matchId === matchId)) continue;
        networkAttempts++;
        try {
          const acquired = await acquireMatch(matchId, async () => {
            if (downloadAttempts >= maxNew) throw new Error('Replay download budget exhausted');
            const disk = await statfs(CACHE);
            if (disk.bavail * disk.bsize < 4 * 1024 ** 3) throw new Error('Less than 4 GiB free disk space; another replay download is refused');
            downloadAttempts++;
            report.downloadAttempts = downloadAttempts;
          });
          const reload = () => loadReplay(acquired.file, matchId, acquired.acquisition, acquired.metadata);
          const loaded = await reload(); newlyPrepared++;
          addSource(loaded, reload);
          selection = selectCorpus(candidates, verifiedExisting(), target, seed, maxPerMatch, priorityIds);
          await writeReport({ ...report, cacheLoads, networkAttempts, downloadAttempts, newlyPrepared, available: selection.selected.length, failures, retired });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ source: matchId, error: message }); console.error(`Candidate ${matchId} failed: ${message}`);
          await writeReport({ ...report, cacheLoads, networkAttempts, downloadAttempts, newlyPrepared, available: selection.selected.length, failures, retired });
        }
      }
    }
    const selected = selection.selected;
    if (!selected.length) throw new Error('No acceptable real encounters were generated; see candidate failures in the report');
    if (values['verify-only'] && existing.length !== target) throw new Error(`Verify-only expected ${target} published real snippets, found ${existing.length}`);
    if (values['verify-only'] && selection.retiredIds.length) throw new Error('Published corpus violates the per-match cap; regenerate before verification');
    if (values['verify-only'] && selected.length !== existing.length) throw new Error('Some published entries could not be verified against source caches');
    const uniqueIds = new Set(selected.map(scenario => scenario.id)), outcomes = new Set(selected.map(outcomeKey));
    if (uniqueIds.size !== selected.length || outcomes.size !== selected.length) throw new Error('Duplicate corpus IDs or source outcomes');
    if (selected.some((scenario, index) => selected.slice(index + 1).some(other => windowsConflict(scenario, other)))) throw new Error('Corpus window-spacing violation');
    const matchCounts: Record<string, number> = {};
    for (const scenario of selected) {
      if (scenario.source.kind !== 'replay' || !scenario.source.matchId) throw new Error('Corpus match identity is missing');
      matchCounts[scenario.source.matchId] = (matchCounts[scenario.source.matchId] ?? 0) + 1;
    }
    if (Object.values(matchCounts).some(count => count > maxPerMatch)) throw new Error('Corpus per-match cap violation');
    for (const hash of new Set(selected.map(scenario => scenario.source.kind === 'replay' ? scenario.source.replaySha256 : ''))) {
      const reload = loaders.get(hash);
      if (!reload) throw new Error(`Cannot verify existing snippets: source cache unavailable for ${hash}`);
      const { raw, source } = await reload();
      for (const scenario of selected.filter(scenario => scenario.source.kind === 'replay' && scenario.source.replaySha256 === hash)) {
        verifyAgainstReplay(scenario, raw, source);
      }
    }
    const map = await exists('public/maps/dota-6934.json') ? clientMapSchema.parse(await readJson('public/maps/dota-6934.json')) : null;
    const distribution = sources.map(source => {
      const clips = selected.filter(scenario => scenario.source.kind === 'replay' && scenario.source.replaySha256 === source.replaySha256);
      const terrain = clips.length && map ? clientMapEligibility(map, clips[0]) : { eligible: false, reason: 'No checked client reference' };
      return { ...source, accepted: clips.length, staticTerrain: terrain.eligible ? 'existing-22-tower-checked-reference' : 'omitted', terrainReason: terrain.reason };
    });
    const dailyChanges: { day: string; previous: string; next: string | null }[] = [];
    const updatedScenarioIds: string[] = [];
    if (!values['verify-only']) {
      for (const scenario of selected) {
        const previous = publishedById.get(scenario.id);
        if (!previous || JSON.stringify(previous) !== JSON.stringify(scenario)) {
          await atomicJson(join(OUT, `${scenario.id}.json`), scenario, { compact: true });
          if (previous) updatedScenarioIds.push(scenario.id);
        }
      }
      const realEntries = selected.map(scenario => ({
        id: scenario.id, title: `${scenario.title} (${scenario.source.matchId} @ ${scenario.startTime.toFixed(1)}s)`,
        kind: 'replay' as const, path: `/scenarios/${scenario.id}.json`,
        matchStartTime: scenario.source.kind === 'replay' ? scenario.source.matchStartTime : null,
      }));
      const activeIds = new Set(selected.map(scenario => scenario.id));
      const daily = Object.fromEntries(Object.entries(catalog.daily).filter(([, id]) => activeIds.has(id)));
      const used = new Set<string>(), random = seededRandom(seed), order = [...selected];
      for (let i = order.length - 1; i > 0; i--) { const j = random(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      const firstDay = Date.parse(`${utcDay(new Date(now))}T00:00:00Z`);
      const reserved = new Set(Object.entries(daily).filter(([day]) => {
        const date = Date.parse(`${day}T00:00:00Z`);
        return date >= firstDay && date < firstDay + target * 86400000;
      }).map(([, id]) => id));
      for (let offset = 0; offset < target; offset++) {
        const date = firstDay + offset * 86400000, day = utcDay(new Date(date));
        const eligible = (scenario: Scenario) => scenario.source.kind === 'replay' && matchEligibility(scenario.source.matchStartTime, Math.max(now, date)).eligible;
        const pinned = selected.find(scenario => scenario.id === daily[day] && eligible(scenario));
        if (pinned && !used.has(pinned.id)) { used.add(pinned.id); continue; }
        const next = order.find(scenario => !used.has(scenario.id) && !reserved.has(scenario.id) && eligible(scenario));
        if (next) { daily[day] = next.id; used.add(next.id); }
        else delete daily[day];
      }
      await atomicJson(join(OUT, 'index.json'), catalogSchema.parse({
        version: 1, scenarios: realEntries, daily,
        retiredQuestionIds: [...retiredQuestionIds].sort(),
      }));
      for (const [day, id] of Object.entries(catalog.daily)) {
        if (daily[day] !== id) dailyChanges.push({ day, previous: id, next: daily[day] ?? null });
      }
      const archived = allPublished.filter(scenario => !activeIds.has(scenario.id));
      if (archived.length) {
        const archive = join(CACHE, 'retired-scenarios', String(now));
        await mkdir(archive, { recursive: true });
        for (const scenario of archived) await rename(join(OUT, `${scenario.id}.json`), join(archive, `${scenario.id}.json`));
        report.archivedScenarioIds = archived.map(scenario => scenario.id);
        report.archiveDirectory = `.cache/retired-scenarios/${now}`;
      }
    }
    const starts = distribution.filter(source => source.accepted).map(source => source.matchStartTime);
    const { 'existing-over-match-cap': capRetirements = 0, 'existing-over-target': targetRetirements = 0, ...candidateExclusions } = selection.excluded;
    Object.assign(report, {
      status: selected.length === target ? (values['verify-only'] ? 'verified' : 'complete') : 'partial',
      finishedAt: new Date().toISOString(), accepted: selected.length, actualPublishedRealCount: values['verify-only'] ? existing.length : selected.length,
      reused: selection.reused, newlyAccepted: values['verify-only'] ? 0 : selection.newlyAccepted,
      acceptedIds: selected.map(scenario => scenario.id), distinctAnswers: new Set(selected.map(scenario => scenario.question.answerId)).size,
      distinctHeroes: new Set(selected.flatMap(scenario => scenario.startSnapshot.heroes.map(hero => hero.id))).size,
      distinctMatches: Object.keys(matchCounts).length, matchDistribution: matchCounts, dailyChanges, updatedScenarioIds,
      retiredQuestionIds: [...retiredQuestionIds].sort(),
      candidateCount: candidates.length, eligiblePoolCount: selection.eligiblePoolCount, candidateExclusions,
      retirementExclusions: { overMatchCap: capRetirements, overTarget: targetRetirements, currentPolicy: retired.length, sourceUnavailable: existing.filter(scenario => scenario.source.kind === 'replay' && !loaders.has(scenario.source.replaySha256)).length },
      candidateAccounting: {
        examinedDeaths: sources.reduce((sum, source) => sum + source.examinedDeaths, 0),
        extractionRejected: sources.reduce((sum, source) => sum + Object.values(source.rejected).reduce((a, b) => a + b, 0), 0),
        validCandidates: candidates.length, selectionExcluded: Object.values(candidateExclusions).reduce((a, b) => a + b, 0),
        newlyAccepted: selection.newlyAccepted, reused: selection.reused, activeTotal: selected.length,
      },
      cacheLoads, networkAttempts, downloadAttempts, newlyPrepared, failures, retired, sources: distribution,
      dateRange: { oldestMatch: new Date(Math.min(...starts) * 1000).toISOString(), newestMatch: new Date(Math.max(...starts) * 1000).toISOString() },
      verification: { schema: true, exactSourceFramesAndEvents: true, derivedFirstDeath: true, recent: true, uniqueIdsAndOutcomes: true, nonOverlapping: true, perMatchCap: Object.values(matchCounts).every(count => count <= maxPerMatch), maxFourHeroes: selected.every(scenario => scenario.startSnapshot.heroes.length <= MAX_SCENARIO_HEROES), heroTrajectoryCamera: true },
      limitations: ['First-death questions only; no counterfactual or escape simulation.', 'Seeded selection balances matches within the hard cap, without hero or victim ranking.', 'Unchecked replay hashes never inherit static client terrain.'],
    });
    await writeReport(report);
    console.log(JSON.stringify({ status: report.status, accepted: selected.length, target, sources: distribution.map(source => ({ matchId: source.matchId, accepted: source.accepted, staticTerrain: source.staticTerrain })), networkAttempts, report: 'public/scenarios/corpus-report.json' }, null, 2));
    if (selected.length < target) process.exitCode = 2;
  } catch (error) {
    await writeReport({ ...report, status: 'failed', finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await lock.close(); await rm(lockPath, { force: true });
  }
}
main().catch(error => { console.error(`Corpus generation failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
