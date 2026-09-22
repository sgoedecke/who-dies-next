import { createHash } from 'node:crypto';
import { scenarioSchema, scenarioArchiveSchema, type RawReplay, type Scenario } from '../shared/scenario.js';
import { MAX_SCENARIO_HEROES, MAX_HERO_SPAN, trajectoryBounds } from '../shared/encounter.js';
import { assertRecentMatch } from '../shared/recent.js';
import type { ReplaySource } from './replay.js';
import { scanScenarios } from './extract.js';

export const MIN_WINDOW_GAP = 15;
export function seededRandom(seed: string): (maximum: number) => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return maximum => {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid random bound');
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return Math.floor((state >>> 0) / 4294967296 * maximum);
  };
}
const replaySource = (scenario: Scenario): ReplaySource => {
  if (scenario.source.kind !== 'replay') throw new Error('Corpus accepts real replay scenarios only');
  return scenario.source;
};
export function outcomeKey(scenario: Scenario): string {
  const first = scenario.events.find(event => event.type === 'death' && event.targetId === scenario.question.answerId);
  if (!first) throw new Error('Scenario has no answer death');
  return `${replaySource(scenario).replaySha256}:${Math.round((scenario.startTime + first.time) * 1000)}:${first.targetId}`;
}
export function windowsConflict(a: Scenario, b: Scenario): boolean {
  const sa = replaySource(a), sb = replaySource(b);
  return (sa.replaySha256 === sb.replaySha256 || (sa.matchId !== null && sa.matchId === sb.matchId))
    && Math.abs(a.startTime - b.startTime) < MIN_WINDOW_GAP - 0.000001;
}
export function qualityRejection(scenario: Scenario): string | null {
  if (scenario.startSnapshot.heroes.length > MAX_SCENARIO_HEROES) return 'more-than-four-relevant-heroes';
  const bounds = trajectoryBounds(scenario.frames);
  if (!bounds || scenario.frames.some(frame => frame.heroes.some(hero => hero.x === null || hero.y === null))) return 'participant-position-unknown';
  if (bounds.maxX - bounds.minX > MAX_HERO_SPAN || bounds.maxY - bounds.minY > MAX_HERO_SPAN) return 'encounter-too-spread';
  const options = scenario.startSnapshot.heroes.filter(hero => scenario.question.optionIds.includes(hero.id));
  if (options.some(hero => hero.x === null || hero.y === null || hero.hp === null || hero.hp <= 0 || hero.maxHp === null || hero.maxHp <= 0)) {
    return 'unreadable-initial-option-state';
  }
  if (new Set(options.map(hero => hero.team)).size < 2) return 'no-live-opposition';
  const heroes = new Map(scenario.startSnapshot.heroes.map(hero => [hero.id, hero]));
  if (!scenario.events.some(event => event.type === 'damage' && event.value !== null && event.value > 0
    && event.actorId && event.targetId && heroes.has(event.actorId) && heroes.has(event.targetId)
    && heroes.get(event.actorId)!.team !== heroes.get(event.targetId)!.team)) return 'no-observed-hero-combat';
  return null;
}

export function samePuzzleIdentity(previous: Scenario, next: Scenario): boolean {
  const sortedIds = (ids: string[]) => JSON.stringify([...ids].sort());
  return previous.id === next.id && previous.duration === next.duration
    && previous.source.kind === 'replay' && next.source.kind === 'replay'
    && previous.source.replaySha256 === next.source.replaySha256
    && previous.question.answerId === next.question.answerId
    && sortedIds(previous.question.optionIds) === sortedIds(next.question.optionIds)
    && sortedIds(previous.startSnapshot.heroes.map(hero => hero.id)) === sortedIds(next.startSnapshot.heroes.map(hero => hero.id));
}

export function selectCorpus(candidates: Scenario[], existing: Scenario[], target: number, seed: string, maxPerMatch = 5, priorityIds: string[] = []) {
  if (!Number.isInteger(target) || target < 1 || target > 100) throw new Error('Corpus target must be 1-100');
  if (!Number.isInteger(maxPerMatch) || maxPerMatch < 1 || maxPerMatch > 5) throw new Error('Per-match cap must be 1-5');
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const selected: Scenario[] = [], retiredIds: string[] = [], ids = new Set<string>(), outcomes = new Set<string>();
  const matchKey = (scenario: Scenario) => replaySource(scenario).matchId ?? replaySource(scenario).replaySha256;
  const counts = new Map<string, number>(), priority = new Set(priorityIds);
  for (const scenario of [...existing].sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)))) {
    const quality = qualityRejection(scenario);
    if (quality) throw new Error(`Existing scenario ${scenario.id} fails corpus quality: ${quality}`);
    if (ids.has(scenario.id) || outcomes.has(outcomeKey(scenario))) throw new Error('Existing corpus contains duplicate encounters');
    if (existing.some(other => other !== scenario && windowsConflict(scenario, other))) throw new Error('Existing corpus contains overlapping windows');
    ids.add(scenario.id); outcomes.add(outcomeKey(scenario));
    const key = matchKey(scenario);
    if ((counts.get(key) ?? 0) >= maxPerMatch) { retiredIds.push(scenario.id); exclude('existing-over-match-cap'); }
    else { selected.push(scenario); counts.set(key, (counts.get(key) ?? 0) + 1); }
  }
  if (selected.length > target) {
    const available = [...selected], retained: Scenario[] = [];
    const rank = (scenario: Scenario) => createHash('sha256').update(`${seed}:${scenario.id}`).digest('hex');
    counts.clear();
    while (retained.length < target) {
      available.sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id))
        || (counts.get(matchKey(a)) ?? 0) - (counts.get(matchKey(b)) ?? 0)
        || rank(a).localeCompare(rank(b)));
      const next = available.shift()!;
      retained.push(next); counts.set(matchKey(next), (counts.get(matchKey(next)) ?? 0) + 1);
    }
    for (const scenario of available) { retiredIds.push(scenario.id); exclude('existing-over-target'); }
    selected.splice(0, selected.length, ...retained);
  }
  const keptExisting = [...selected];
  const pool: Scenario[] = [];
  // Earliest-finish packing preserves capacity; randomness selects among already non-overlapping encounters.
  for (const scenario of [...candidates].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))) {
    if (ids.has(scenario.id)) { exclude('duplicate-or-already-published-id'); continue; }
    ids.add(scenario.id);
    const quality = qualityRejection(scenario);
    if (quality) { exclude(quality); continue; }
    const outcome = outcomeKey(scenario);
    if (outcomes.has(outcome)) { exclude('same-source-death'); continue; }
    if ([...keptExisting, ...pool].some(other => windowsConflict(scenario, other))) { exclude('within-15-seconds-of-another-window'); continue; }
    outcomes.add(outcome); pool.push(scenario);
  }
  const poolCounts = new Map<string, number>();
  for (const scenario of pool) poolCounts.set(matchKey(scenario), (poolCounts.get(matchKey(scenario)) ?? 0) + 1);
  const eligiblePoolCount = keptExisting.length + [...poolCounts].reduce((sum, [key, count]) => sum + Math.min(count, maxPerMatch - (counts.get(key) ?? 0)), 0);
  const ranks = new Map(pool.map(scenario => [scenario.id, createHash('sha256').update(`${seed}:${scenario.id}`).digest('hex')]));
  while (selected.length < target && pool.length) {
    for (let index = pool.length - 1; index >= 0; index--) {
      if ((counts.get(matchKey(pool[index])) ?? 0) >= maxPerMatch) { pool.splice(index, 1); exclude('match-cap'); }
    }
    if (!pool.length) break;
    pool.sort((a, b) =>
      (counts.get(matchKey(a)) ?? 0) - (counts.get(matchKey(b)) ?? 0)
      || ranks.get(a.id)!.localeCompare(ranks.get(b.id)!));
    const next = pool.shift()!;
    selected.push(next); counts.set(matchKey(next), (counts.get(matchKey(next)) ?? 0) + 1);
  }
  if (pool.length) excluded['target-reached'] = pool.length;
  return { selected, excluded, eligiblePoolCount, newlyAccepted: selected.length - keptExisting.length, reused: keptExisting.length, retiredIds };
}

export function verifyAgainstReplay(input: Scenario, raw: RawReplay, source: ReplaySource, nowMs = Date.now()): void {
  verifyEvidence(input, raw, source, nowMs, true);
}

export function verifyArchivedSource(input: Scenario, raw: RawReplay, source: ReplaySource, nowMs = Date.now()): void {
  verifyEvidence(input, raw, source, nowMs, false);
}

function verifyEvidence(input: Scenario, raw: RawReplay, source: ReplaySource, nowMs: number, currentPolicy: boolean): void {
  const scenario = (currentPolicy ? scenarioSchema : scenarioArchiveSchema).parse(input), actual = replaySource(scenario);
  assertRecentMatch(actual.matchStartTime, `Scenario ${scenario.id}`, nowMs);
  if (actual.matchId !== source.matchId || actual.matchId !== raw.matchId || actual.replaySha256 !== source.replaySha256
    || actual.matchStartTime !== source.matchStartTime) throw new Error(`Source identity/date mismatch: ${scenario.id}`);
  const canonicalId = `replay-${actual.matchId ?? actual.replaySha256.slice(0, 12)}-${Math.round(scenario.startTime * 1000)}`;
  if (scenario.id !== canonicalId) throw new Error('Non-canonical scenario ID');
  const start = raw.frames.findIndex(frame => Math.abs(frame.time - scenario.startTime) < 0.000001);
  const end = raw.frames.findIndex((frame, index) => index > start && frame.time >= scenario.startTime + scenario.duration);
  if (start < 0 || end < 0 || end - start + 1 !== scenario.frames.length) throw new Error(`Source window/frame mismatch: ${scenario.id}`);
  const heroIds = new Set(scenario.startSnapshot.heroes.map(hero => hero.id));
  const towerIds = new Set(scenario.frames.flatMap(frame => (frame.towers ?? []).map(tower => tower.id)));
  const same = (a: unknown, b: unknown, field: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`Source ${field} mismatch: ${scenario.id}`);
  };
  for (const [index, frame] of scenario.frames.entries()) {
    const original = raw.frames[start + index];
    same(frame.time, +(original.time - scenario.startTime).toFixed(6), 'sample time');
    same(frame.heroes, original.heroes.filter(hero => heroIds.has(hero.id)), 'hero state');
    same(frame.towers, original.towers?.filter(tower => towerIds.has(tower.id)), 'tower state');
    const bounds = scenario.bounds;
    same(frame.trees, original.trees === undefined ? undefined : original.trees?.filter(tree =>
      tree.x !== null && tree.y !== null && tree.x >= bounds.minX && tree.x <= bounds.maxX && tree.y >= bounds.minY && tree.y <= bounds.maxY) ?? null, 'tree state');
  }
  const events = raw.events.filter(event => event.time > scenario.startTime && event.time <= scenario.startTime + scenario.duration
    && ((event.targetId && heroIds.has(event.targetId)) || (event.actorId && heroIds.has(event.actorId))))
    .map(event => ({ ...event, time: +(event.time - scenario.startTime).toFixed(6) }));
  same(scenario.events, events, 'events');
  const death = raw.events.filter(event => event.type === 'death' && event.targetId && scenario.question.optionIds.includes(event.targetId)
    && event.time > scenario.startTime && event.time <= scenario.startTime + scenario.duration).sort((a, b) => a.time - b.time)[0];
  if (!death || death.targetId !== scenario.question.answerId) throw new Error(`Source first-death outcome mismatch: ${scenario.id}`);
  same(scenario.sampleInterval, raw.sampleInterval, 'sampling interval');
  if (!currentPolicy) return;
  const canonical = scanScenarios(raw, actual, { limit: 1, after: scenario.startTime, minStartGap: 0 }).scenarios[0];
  if (!canonical || canonical.id !== scenario.id) throw new Error(`Cannot regenerate the source encounter: ${scenario.id}`);
  same(scenario.bounds, canonical.bounds, 'encounter bounds');
  same(scenario.duration, canonical.duration, 'window duration');
  same(scenario.question.optionIds, canonical.question.optionIds, 'nearby/remote combat options');
  same(scenario.startSnapshot.heroes.map(hero => hero.id), canonical.startSnapshot.heroes.map(hero => hero.id), 'combat participants');
}
