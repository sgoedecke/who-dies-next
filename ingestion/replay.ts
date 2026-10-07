import { randomInt } from 'node:crypto';
import { resolve, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { rawReplaySchema, sourceSchema, type RawReplay, type Scenario } from '../shared/scenario.js';
import { assertRecentMatch, MAX_MATCH_AGE_SECONDS, matchEligibility } from '../shared/recent.js';
import { assertReplay, atomicJson, decompress, exists, readJson, runWorker, sha256 } from './files.js';
import { downloadReplay, jsonRequest } from './network.js';

export const CACHE = resolve('.cache');
export const OUT = resolve('public/scenarios');
export const PARSED_SUFFIX = '-clarity-4.0.1-v3.json';
export type ReplaySource = Extract<Scenario['source'], { kind: 'replay' }>;
export interface LoadedReplay { raw: RawReplay; source: ReplaySource }
export const matchSchema = z.object({
  match_id: z.number().int().positive(), replay_url: z.string().optional().nullable(),
  cluster: z.number().optional(), replay_salt: z.number().optional(), patch: z.number().optional(),
  start_time: z.number().int().nullable().optional(),
});
export type MatchMetadata = z.infer<typeof matchSchema>;
const provenanceSchema = z.object({
  version: z.literal(1), replayPath: z.string(), rawSha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: sourceSchema,
});

export async function discoverMatches(source: 'public' | 'parsed' | 'pro' | 'ranked', attempts: number, random = randomInt): Promise<string[]> {
  // "ranked" means recent public matches averaging Immortal rank.
  const endpoint = { public: 'publicMatches', parsed: 'parsedMatches', pro: 'proMatches', ranked: 'publicMatches?min_rank=80' }[source];
  console.log(`Discovering recent matches through OpenDota /${endpoint}`);
  const list = z.array(z.object({
    match_id: z.number().int().positive(), duration: z.number().optional(), start_time: z.number().optional(),
  })).parse(await jsonRequest(`https://api.opendota.com/api/${endpoint}`));
  const candidates = [...new Set(list.filter(match =>
    (match.duration === undefined || match.duration > 300)
    && (match.start_time === undefined || (matchEligibility(match.start_time).eligible
      && match.start_time >= Date.now() / 1000 - Math.min(MAX_MATCH_AGE_SECONDS, 6 * 86400))),
  ).map(match => String(match.match_id)))];
  for (let index = candidates.length - 1; index > 0; index--) {
    const other = random(index + 1);
    [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
  }
  return candidates.slice(0, attempts);
}

export async function acquireMatch(matchId: string, beforeDownload?: () => void | Promise<void>): Promise<{ file: string; metadata: MatchMetadata; acquisition: string }> {
  if (!/^\d{6,20}$/.test(matchId)) throw new Error('Invalid numeric Dota match ID');
  await sleep(1500);
  const metadataPath = join(CACHE, `${matchId}.match.json`);
  const cachedMetadata = await exists(metadataPath) ? matchSchema.parse(await readJson(metadataPath)) : null;
  const metadata = cachedMetadata && await exists(join(CACHE, `${matchId}.dem`))
    ? cachedMetadata : matchSchema.parse(await jsonRequest(`https://api.opendota.com/api/matches/${matchId}`));
  if (String(metadata.match_id) !== matchId) throw new Error('API returned a different match ID');
  assertRecentMatch(metadata.start_time, `Match ${matchId}`);
  await atomicJson(join(CACHE, `${matchId}.match.json`), metadata);
  const url = metadata.replay_url ?? (metadata.cluster && metadata.replay_salt
    ? `http://replay${metadata.cluster}.valve.net/570/${matchId}_${metadata.replay_salt}.dem.bz2` : null);
  if (!url) throw new Error('No public replay URL/salt available. Match may be unparsed, unavailable, or expired. Try --source parsed or another match.');
  const file = join(CACHE, `${matchId}.dem`), manifestPath = join(CACHE, `${matchId}.download.json`);
  if (await exists(file) && await exists(manifestPath)) {
    const manifest = z.object({ replaySha256: z.string(), url: z.string() }).parse(await readJson(manifestPath));
    if (manifest.url !== url || manifest.replaySha256 !== await sha256(file)) {
      throw new Error('Cached replay integrity mismatch; move the corrupted cache file aside and retry');
    }
    console.log('Reusing SHA-256 verified cached replay');
  } else {
    await beforeDownload?.();
    const compressed = url.endsWith('.bz2') ? join(CACHE, `${matchId}.dem.bz2`) : file;
    console.log(`Downloading ${url} (256 MiB / 180s limit)`);
    await downloadReplay(url, compressed);
    if (compressed !== file) await decompress(compressed, file);
    await assertReplay(file);
    await atomicJson(manifestPath, {
      matchId, url, replaySha256: await sha256(file), acquiredAt: new Date().toISOString(), openDotaPatchIndex: metadata.patch ?? null,
    });
  }
  await assertReplay(file);
  return { file, metadata, acquisition: `OpenDota match replay URL: ${url}` };
}

export async function loadReplay(file: string, expectedMatch: string | null, acquisition: string, metadata?: MatchMetadata, allowMetadataRequest = true): Promise<LoadedReplay> {
  await assertReplay(file);
  const hash = await sha256(file), rawPath = join(CACHE, `${hash}${PARSED_SUFFIX}`);
  const provenancePath = join(CACHE, `${hash}.provenance.json`);
  const prior = await exists(provenancePath) ? provenanceSchema.parse(await readJson(provenancePath)) : null;
  if (prior && (prior.source.kind !== 'replay' || prior.source.replaySha256 !== hash)) throw new Error('Cached source provenance identity mismatch');
  if (!await exists(rawPath)) {
    console.log('Parsing actual .dem entities and events using Clarity...');
    await runWorker(file, rawPath);
  } else console.log('Reusing parsed replay cache');
  const rawHash = await sha256(rawPath);
  if (prior && prior.rawSha256 !== rawHash) throw new Error('Parsed replay cache integrity mismatch');
  const raw = rawReplaySchema.parse(await readJson(rawPath));
  if (expectedMatch && raw.matchId && raw.matchId !== expectedMatch) throw new Error(`Replay match ${raw.matchId} does not match requested ${expectedMatch}`);
  const matchId = raw.matchId ?? expectedMatch;
  if (!metadata && raw.matchStartTime === null && matchId !== null) {
    if (!/^\d{6,20}$/.test(matchId)) throw new Error('Replay has an invalid match ID; cannot verify match age');
    const metadataPath = join(CACHE, `${matchId}.match.json`);
    if (!allowMetadataRequest && !await exists(metadataPath)) throw new Error(`Offline cache has no verified match-start metadata for ${matchId}`);
    try {
      metadata = matchSchema.parse(await (await exists(metadataPath) ? readJson(metadataPath) : jsonRequest(`https://api.opendota.com/api/matches/${matchId}`)));
    } catch (error) {
      throw new Error(`Cannot verify local replay match age for ${matchId}; publication refused. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (String(metadata.match_id) !== matchId) throw new Error('Age metadata belongs to a different match');
    await atomicJson(metadataPath, metadata);
  }
  if (metadata && String(metadata.match_id) !== matchId) throw new Error('Age metadata belongs to a different match');
  const matchStartTime = metadata?.start_time ?? raw.matchStartTime;
  assertRecentMatch(matchStartTime, `Replay ${matchId ?? '(no match ID)'}`);
  const source: ReplaySource = {
    kind: 'replay', label: 'Extracted from a real Dota 2 replay', matchId, patch: raw.patch, matchStartTime,
    matchStartTimeSource: metadata?.start_time != null ? `OpenDota /matches/${matchId}.start_time` : 'Replay metadata',
    replaySha256: hash, parser: `${raw.parser.name} ${raw.parser.version}`,
    extractedAt: prior?.source.kind === 'replay' ? prior.source.extractedAt : new Date().toISOString(), acquisition,
  };
  await atomicJson(provenancePath, { version: 1, replayPath: resolve(file), rawSha256: rawHash, source });
  return { raw, source };
}

export async function cachedReplayInputs(offline = false): Promise<{ key: string; load: () => Promise<LoadedReplay> }[]> {
  const files = (await readdir(CACHE)).sort();
  const inputs: { key: string; load: () => Promise<LoadedReplay> }[] = [];
  const seen = new Set<string>();
  for (const name of files.filter(name => /^[0-9a-f]{64}\.provenance\.json$/.test(name))) {
    const hash = name.slice(0, 64);
    inputs.push({ key: hash, load: async () => {
      const provenance = provenanceSchema.parse(await readJson(join(CACHE, name)));
      const source = provenance.source;
      if (source.kind !== 'replay' || source.replaySha256 !== hash) throw new Error('Invalid cached replay provenance');
      assertRecentMatch(source.matchStartTime, `Cached match ${source.matchId}`);
      const rawPath = join(CACHE, `${hash}${PARSED_SUFFIX}`);
      if (await sha256(rawPath) !== provenance.rawSha256) throw new Error('Parsed replay cache integrity mismatch');
      const raw = rawReplaySchema.parse(await readJson(rawPath));
      if (raw.matchId !== source.matchId) throw new Error('Cached replay match ID mismatch');
      return { raw, source };
    } });
    seen.add(hash);
  }
  for (const name of files.filter(name => /^\d+\.download\.json$/.test(name))) {
    const record = z.object({ matchId: z.string().optional(), replaySha256: z.string(), url: z.string() }).parse(await readJson(join(CACHE, name)));
    if (seen.has(record.replaySha256)) continue;
    const matchId = name.split('.')[0], file = join(CACHE, `${matchId}.dem`);
    inputs.push({ key: record.replaySha256, load: async () => {
      if (await sha256(file) !== record.replaySha256) throw new Error(`Cached source replay integrity mismatch: ${matchId}`);
      return loadReplay(file, matchId, `OpenDota match replay URL: ${record.url}`, undefined, !offline);
    } });
    seen.add(record.replaySha256);
  }
  return inputs;
}
