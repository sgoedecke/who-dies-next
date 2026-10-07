import { parseArgs } from 'node:util';
import { readdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogSchema, type Catalog, type Scenario } from '../shared/scenario.js';
import { MAX_SCENARIO_HEROES } from '../shared/encounter.js';
import { atomicJson, exists, readJson } from './files.js';
import { acquireMatch, cachedReplayInputs, discoverMatches, loadReplay, CACHE, OUT, type LoadedReplay } from './replay.js';
import { scanScenarios } from './extract.js';
import { outcomeKey, qualityRejection, windowsConflict } from './corpus.js';
import { clipFeatures, difficulty, interestScore, type ClipFeatures } from './interest.js';

interface Candidate { scenario: Scenario; features: ClipFeatures; interest: number; difficulty: number }

const help = `Build the published corpus from the most interesting clips in every cached replay,
optionally downloading new matches first.

  npm run corpus -- [--source pro|ranked|parsed|public] [--new 20] [--target 300]
                    [--max-per-match 5] [--min-interest 2] [--offline]

--new            New replays to download and parse before selecting (default 0).
--target         Maximum clips to publish (default 300).
--max-per-match  Clips per match (default 5).
--min-interest   Drop clips scoring below this (default 2).`;

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: 'string', default: 'pro' }, new: { type: 'string', default: '0' },
    target: { type: 'string', default: '300' }, 'max-per-match': { type: 'string', default: '5' },
    'min-interest': { type: 'string', default: '2' }, offline: { type: 'boolean', default: false },
    attempts: { type: 'string', default: '60' }, help: { type: 'boolean', short: 'h' },
  }, strict: true });
  if (values.help) { console.log(help); return; }
  const source = values.source;
  if (source !== 'pro' && source !== 'ranked' && source !== 'parsed' && source !== 'public') throw new Error('Invalid --source');
  const wanted = values.offline ? 0 : Number(values.new), target = Number(values.target);
  const maxPerMatch = Number(values['max-per-match']), minInterest = Number(values['min-interest']), attempts = Number(values.attempts);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const rejected: Record<string, number> = {};
  const sources: { matchId: string | null; deaths: number; candidates: number }[] = [];
  const addSource = ({ raw, source: replay }: LoadedReplay) => {
    if (seen.has(replay.replaySha256)) return;
    seen.add(replay.replaySha256);
    const scan = scanScenarios(raw, replay, { limit: 10000, minStartGap: 0 });
    for (const [reason, count] of Object.entries(scan.rejected)) rejected[reason] = (rejected[reason] ?? 0) + count;
    let admitted = 0;
    for (const scenario of scan.scenarios) {
      const quality = qualityRejection(scenario);
      if (quality) { rejected[quality] = (rejected[quality] ?? 0) + 1; continue; }
      const features = clipFeatures(scenario);
      candidates.push({ scenario, features, interest: interestScore(features), difficulty: difficulty(features) });
      admitted++;
    }
    sources.push({ matchId: replay.matchId, deaths: raw.events.filter(event => event.type === 'death').length, candidates: admitted });
    console.log(`  ${replay.matchId}: ${admitted} candidate clips`);
  };

  console.log('Scanning cached replays');
  for (const input of await cachedReplayInputs(values.offline)) {
    try { addSource(await input.load()); }
    catch (error) { console.error(`Cached source ${input.key} skipped: ${error instanceof Error ? error.message : error}`); }
  }

  if (wanted > 0) {
    const cachedMatches = new Set((await readdir(CACHE)).filter(name => /^\d+\.download\.json$/.test(name)).map(name => name.split('.')[0]));
    const discovered = (await discoverMatches(source, attempts)).filter(id => !cachedMatches.has(id));
    let added = 0;
    for (const matchId of discovered) {
      if (added >= wanted) break;
      try {
        console.log(`Acquiring ${matchId} (${added + 1}/${wanted})`);
        const acquired = await acquireMatch(matchId, async () => {
          const disk = await statfs(CACHE);
          if (disk.bavail * disk.bsize < 4 * 1024 ** 3) throw new Error('Less than 4 GiB free disk space');
        });
        addSource(await loadReplay(acquired.file, matchId, acquired.acquisition, acquired.metadata));
        added++;
        // Raw replays are only needed for parsing; the parsed cache (with provenance) is what selection reads.
        await rm(join(CACHE, `${matchId}.dem.bz2`), { force: true });
        await rm(join(CACHE, `${matchId}.dem`), { force: true });
      } catch (error) {
        console.error(`  ${matchId} failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  // Best clips first; within a match keep windows apart and outcomes unique.
  const ranked = candidates.filter(candidate => candidate.interest >= minInterest).sort((a, b) => b.interest - a.interest || a.scenario.id.localeCompare(b.scenario.id));
  const chosen: Candidate[] = [];
  const outcomes = new Set<string>(), perMatch = new Map<string, number>();
  for (const candidate of ranked) {
    if (chosen.length >= target) break;
    const match = candidate.scenario.source.kind === 'replay' ? candidate.scenario.source.matchId ?? candidate.scenario.source.replaySha256 : '';
    if ((perMatch.get(match) ?? 0) >= maxPerMatch) continue;
    const outcome = outcomeKey(candidate.scenario);
    if (outcomes.has(outcome) || chosen.some(other => windowsConflict(candidate.scenario, other.scenario))) continue;
    chosen.push(candidate); outcomes.add(outcome); perMatch.set(match, (perMatch.get(match) ?? 0) + 1);
  }
  if (!chosen.length) throw new Error('No clips passed selection');

  const keep = new Set(chosen.map(candidate => `${candidate.scenario.id}.json`));
  for (const name of await readdir(OUT)) {
    if (/^replay-\d+-\d+\.json$/.test(name) && !keep.has(name)) await rm(join(OUT, name));
  }
  for (const { scenario } of chosen) await atomicJson(join(OUT, `${scenario.id}.json`), scenario, { compact: true });
  const ordered = [...chosen].sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
  const catalog: Catalog = catalogSchema.parse({
    version: 1,
    scenarios: ordered.map(({ scenario, interest, difficulty: hardness }) => ({
      id: scenario.id, title: scenario.title, kind: 'replay', path: `/scenarios/${scenario.id}.json`,
      matchStartTime: scenario.source.kind === 'replay' ? scenario.source.matchStartTime : null,
      difficulty: hardness, interest,
    })),
    daily: {},
  });
  await atomicJson(join(OUT, 'index.json'), catalog);

  const lowestHpWins = chosen.filter(candidate => candidate.features.answerHpRank === 0).length;
  const report = {
    version: 2, generatedAt: new Date().toISOString(),
    policy: { maxHeroes: MAX_SCENARIO_HEROES, maxPerMatch, minInterest, target, selection: 'highest interest score first' },
    matches: perMatch.size, clips: chosen.length, candidates: candidates.length,
    lowestHpHeuristicWins: lowestHpWins,
    options: Object.fromEntries([2, 3, 4, 5].map(count => [count, chosen.filter(candidate => candidate.features.options === count).length])),
    multiDeathClips: chosen.filter(candidate => candidate.features.deaths > 1).length,
    interest: { min: chosen.at(-1)!.interest, median: chosen[Math.floor(chosen.length / 2)].interest, max: chosen[0].interest },
    sources, rejected,
  };
  await atomicJson(join(OUT, 'corpus-report.json'), report);
  console.log(`Published ${chosen.length} clips from ${perMatch.size} matches (${candidates.length} candidates).`);
  console.log(`Lowest-HP heuristic wins ${lowestHpWins}/${chosen.length}; interest ${report.interest.min}–${report.interest.max}.`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
