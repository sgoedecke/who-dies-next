import { parseArgs } from 'node:util';
import { resolve, join, basename } from 'node:path';
import { mkdir, open, rm } from 'node:fs/promises';
import { catalogSchema, scenarioArchiveSchema, type Catalog } from '../shared/scenario.js';
import { extractScenarios } from './extract.js';
import { samePuzzleIdentity } from './corpus.js';
import { assertReplay, atomicJson, decompress, exists, readJson, sha256 } from './files.js';
import { acquireMatch, discoverMatches, loadReplay, CACHE, OUT, type MatchMetadata } from './replay.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      match: { type: 'string' }, file: { type: 'string' }, attempts: { type: 'string', default: '5' },
      count: { type: 'string', default: '1' }, daily: { type: 'string' },
      source: { type: 'string', default: 'public' }, 'download-only': { type: 'boolean', default: false },
      after: { type: 'string', default: '0' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Dotadle replay ingestion
  npm run ingest -- [--match ID | --file PATH] [--attempts 5] [--count 1]
                    [--source public|parsed|pro] [--daily YYYY-MM-DD] [--after SECONDS] [--download-only]

Default: shuffle recent public matches, try at most 5, ingest one replay.
--count is scenarios per replay (1-3), not the number of downloads.
--source parsed/pro uses those public discovery lists instead.
--daily pins the first emitted scenario to the given UTC date.
--after skips encounters starting before the given source replay elapsed time.
--download-only resolves/downloads/decompresses without requiring Java.
Only matches with verified start times within the last 180 days are eligible.
Clips contain at most four relevant heroes with compact fully observed trajectories.
No API keys or match-summary substitutes are used.`);
    return;
  }
  if (values.file && values.match) throw new Error('Choose either --file or --match, not both');
  if (values.file && values['download-only']) throw new Error('Local replay age cannot be verified without parsing. Omit --download-only to verify the actual match-start timestamp before publication.');
  if (values.match && !/^\d{6,20}$/.test(values.match)) throw new Error('--match must be a numeric Dota match ID');
  const attempts = Number(values.attempts);
  const count = Number(values.count);
  const after = Number(values.after);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error('--attempts must be 1-10');
  if (!Number.isInteger(count) || count < 1 || count > 3) throw new Error('--count must be 1-3');
  if (!Number.isFinite(after) || after < 0) throw new Error('--after must be a finite nonnegative replay time in seconds');
  if (!['public', 'parsed', 'pro'].includes(values.source!)) throw new Error('--source must be public, parsed, or pro');
  if (values.daily && (!/^\d{4}-\d{2}-\d{2}$/.test(values.daily) || !Number.isFinite(Date.parse(values.daily)) || new Date(values.daily).toISOString().slice(0, 10) !== values.daily)) {
    throw new Error('--daily must be an actual YYYY-MM-DD UTC date');
  }
  if (values.daily && values['download-only']) throw new Error('--daily cannot be combined with --download-only');
  await mkdir(CACHE, { recursive: true });
  const lockPath = join(CACHE, 'ingest.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another ingestion may be running (.cache/ingest.lock). If a prior run was killed, confirm it stopped before removing that lock.');
    throw e;
  }
  await lock.writeFile(String(process.pid));
  try {
    if (values.file) {
      const input = resolve(values.file);
      const compressed = /\.(bz2|zst|zstd)$/.test(input);
      const file = compressed ? join(CACHE, `${(await sha256(input)).slice(0, 20)}.dem`) : input;
      if (compressed) await decompress(input, file);
      await assertReplay(file);
      if (values['download-only']) { console.log(`Replay ready: ${file}`); return; }
      await parseAndPublish(file, null, `Local replay: ${basename(input)}`, count, values.daily, after);
      return;
    }
    let candidates: string[];
    if (values.match) candidates = [values.match];
    else candidates = await discoverMatches(values.source! as 'public' | 'parsed' | 'pro', attempts);
    if (!candidates.length) throw new Error('Discovery returned no recent eligible matches');
    const failures: string[] = [];
    for (const [index, matchId] of candidates.entries()) {
      try {
        console.log(`Candidate ${index + 1}/${candidates.length}: ${matchId}`);
        const acquired = await acquireMatch(matchId);
        if (values['download-only']) { console.log(`Replay ready: ${acquired.file}`); return; }
        await parseAndPublish(acquired.file, matchId, acquired.acquisition, count, values.daily, after, acquired.metadata);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${matchId}: ${message}`);
        console.error(`Candidate failed: ${message}`);
      }
    }
    throw new Error(`No replay ingested after ${candidates.length} bounded candidate attempts:\n${failures.join('\n')}`);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function parseAndPublish(file: string, expectedMatch: string | null, acquisition: string, count: number, daily?: string, after = 0, metadata?: MatchMetadata): Promise<void> {
  const { raw, source } = await loadReplay(file, expectedMatch, acquisition, metadata);
  const matchStartTime = source.matchStartTime;
  const scenarios = extractScenarios(raw, source, count, after);
  const indexPath = join(OUT, 'index.json');
  const catalog: Catalog = await exists(indexPath) ? catalogSchema.parse(await readJson(indexPath)) : { version: 1, scenarios: [], daily: {} };
  const prefix = `replay-${source.matchId ?? source.replaySha256.slice(0, 12)}-`;
  const matchIds = new Set([
    ...catalog.scenarios.filter(entry => entry.kind === 'replay' && entry.id.startsWith(prefix)).map(entry => entry.id),
    ...scenarios.map(scenario => scenario.id),
  ]);
  if (matchIds.size > 5) {
    throw new Error('Publishing would exceed five active snippets from this match. Use the capped corpus generator instead of appending more windows.');
  }
  for (const scenario of scenarios) {
    if (catalog.retiredQuestionIds?.includes(scenario.id)) throw new Error(`Question ${scenario.id} was retired after its participant context changed. Choose a later --after time or use the corpus generator.`);
    const entry = catalog.scenarios.find(existing => existing.id === scenario.id);
    if (!entry) continue;
    if (entry.path !== `/scenarios/${scenario.id}.json`) throw new Error(`Catalog identity/path mismatch: ${entry.id}`);
    const previous = scenarioArchiveSchema.parse(await readJson(join('public', entry.path)));
    if (!samePuzzleIdentity(previous, scenario)) throw new Error(`Publishing would change an existing question under ${scenario.id}. Use the corpus generator to retire it and select another encounter.`);
  }
  for (const scenario of scenarios) {
    await atomicJson(join(OUT, `${scenario.id}.json`), scenario);
    const clock = `${Math.floor(scenario.startTime / 60)}:${String(Math.floor(scenario.startTime % 60)).padStart(2, '0')}`;
    const entry = { id: scenario.id, title: `${scenario.title} (${source.matchId ?? 'local replay'} @ ${clock})`, kind: 'replay' as const, path: `/scenarios/${scenario.id}.json`, matchStartTime };
    const existingIndex = catalog.scenarios.findIndex(s => s.id === scenario.id);
    if (existingIndex < 0) catalog.scenarios.push(entry);
    else catalog.scenarios[existingIndex] = entry;
  }
  if (daily) catalog.daily[daily] = scenarios[0].id;
  await atomicJson(indexPath, catalogSchema.parse(catalog));
  console.log(`Published ${scenarios.length} replay scenario(s); match ${source.matchId ?? 'unknown'}, ${raw.frames.length} real snapshots, ${raw.events.length} events.`);
  for (const scenario of scenarios) console.log(`${scenario.id}: ${scenario.frames.length} frames, ${scenario.startSnapshot.heroes.length} heroes, first death ${scenario.question.answerId}`);
  console.log(`Open /?scenario=${scenarios[0].id}${daily ? ` (daily pinned to ${daily} UTC)` : ''}`);
}

main().catch(error => { console.error(`Ingestion failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
