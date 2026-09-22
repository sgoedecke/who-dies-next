import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestScenario } from './fixtures/scenario.js';
import { catalogSchema, rawReplaySchema, scenarioSchema, type RawReplay, type Scenario } from '../shared/scenario.js';
import { scenarioEligibility } from '../shared/recent.js';
import { extractScenarios, scanScenarios } from '../ingestion/extract.js';
import { outcomeKey, qualityRejection, seededRandom, selectCorpus, verifyAgainstReplay, verifyArchivedSource, samePuzzleIdentity, windowsConflict } from '../ingestion/corpus.js';
import { encounterBounds, MAX_SCENARIO_HEROES } from '../shared/encounter.js';

const now = Date.parse('2026-09-21T12:00:00Z');
const source: Extract<Scenario['source'], { kind: 'replay' }> = {
  kind: 'replay', label: 'Unit fixture, not a real corpus entry', matchId: '12345678', patch: null,
  replaySha256: 'a'.repeat(64), parser: 'clarity 4.0.1', extractedAt: '2026-09-21T00:00:00.000Z',
  acquisition: 'Unit fixture', matchStartTime: 1789980832, matchStartTimeSource: 'Unit fixture',
};
function rawFixture(): RawReplay {
  const demo = createTestScenario();
  return rawReplaySchema.parse({
    schemaVersion: 1, matchId: source.matchId, patch: null,
    parser: { name: 'clarity', version: '4.0.1' }, coordinateSystem: 'dota-world', sampleInterval: 0.25,
    frames: [...demo.frames, ...[10.25, 10.5, 10.75, 11].map(time => ({ ...demo.frames.at(-1)!, time }))],
    events: [
      { time: 1, type: 'damage', actorId: 'npc_dota_hero_axe', targetId: 'npc_dota_hero_windrunner', ability: null, value: 50, description: 'Explicit unit-test combat event' },
      ...demo.events,
    ],
    limitations: ['Unit fixture only'],
  });
}
const fixture = () => extractScenarios(rawFixture(), source, 1)[0];
function shifted(start: number, matchId = '12345678'): Scenario {
  const scenario = fixture();
  scenario.startTime = start;
  scenario.id = `replay-${matchId}-${Math.round(start * 1000)}`;
  scenario.source = { ...source, matchId, replaySha256: (matchId === '12345678' ? 'a' : 'b').repeat(64) };
  return scenario;
}

describe('corpus selection and source verification', () => {
  it('counts every scanned death as an accepted candidate or explicit rejection', () => {
    const raw = rawFixture();
    const scan = scanScenarios(raw, source, { limit: 100, minStartGap: 0 });
    expect(scan.examinedDeaths).toBe(scan.scenarios.length + Object.values(scan.rejected).reduce((a, b) => a + b, 0));
    raw.events.push({ ...raw.events.at(-1)!, targetId: 'npc_dota_hero_lina', time: 6.5 });
    const ambiguous = scanScenarios(raw, source, { limit: 100, minStartGap: 0 });
    expect(ambiguous.scenarios).toHaveLength(0);
    expect(ambiguous.rejected['ambiguous-first-death']).toBeGreaterThan(0);
  });
  it('rejects overlapping padding while allowing distinct windows from different matches', () => {
    expect(windowsConflict(shifted(0), shifted(14.99))).toBe(true);
    expect(windowsConflict(shifted(0), shifted(15))).toBe(false);
    expect(windowsConflict(shifted(0), shifted(0, '87654321'))).toBe(false);
    const result = selectCorpus([shifted(0), shifted(4), shifted(15)], [], 3, 'test');
    expect(result.selected).toHaveLength(2);
    expect(result.excluded['within-15-seconds-of-another-window']).toBe(1);
  });
  it('preserves published IDs, deduplicates outcomes and resumes without padding the target', () => {
    const scenarios = [shifted(0), shifted(20), shifted(40), shifted(60)];
    const first = selectCorpus(scenarios, [], 3, 'same');
    const next = selectCorpus([...scenarios, scenarios[0]], first.selected, 3, 'same');
    expect(next.selected.map(scenario => scenario.id)).toEqual(first.selected.map(scenario => scenario.id));
    expect(next.newlyAccepted).toBe(0);
    expect(new Set(next.selected.map(outcomeKey)).size).toBe(3);
    const reduced = selectCorpus(scenarios, first.selected, 2, 'same', 5, [first.selected[0].id]);
    expect(reduced.selected).toHaveLength(2);
    expect(reduced.selected.some(scenario => scenario.id === first.selected[0].id)).toBe(true);
    expect(reduced.retiredIds).toHaveLength(1);
    expect(reduced.excluded['existing-over-target']).toBe(1);
  });
  it('is deterministic with a seed and favors both source matches', () => {
    const candidates = [0, 20, 40, 60].flatMap(start => [shifted(start), shifted(start, '87654321')]);
    const first = selectCorpus(candidates, [], 4, 'seed');
    expect(selectCorpus([...candidates].reverse(), [], 4, 'seed').selected.map(scenario => scenario.id)).toEqual(first.selected.map(scenario => scenario.id));
    expect(first.selected.filter(scenario => scenario.source.matchId === '12345678')).toHaveLength(2);
    const a = seededRandom('seed'), b = seededRandom('seed');
    expect(Array.from({ length: 10 }, () => a(100))).toEqual(Array.from({ length: 10 }, () => b(100)));
  });
  it('caps resumed entries and daily-pin priority without a hash-based bypass', () => {
    const previous = [0, 20, 40, 60, 80, 100].map(start => shifted(start));
    previous[5].source = { ...source, replaySha256: 'b'.repeat(64) };
    const result = selectCorpus(previous, previous, 6, 'seed', 5, [previous[5].id]);
    expect(result.selected).toHaveLength(5);
    expect(result.selected.some(scenario => scenario.id === previous[5].id)).toBe(true);
    expect(result.retiredIds).toHaveLength(1);
    expect(result.excluded['existing-over-match-cap']).toBe(1);
    expect(() => selectCorpus(previous, [], 6, 'seed', 6)).toThrow('1-5');
  });
  it('requires readable opposing options and observed actual combat', () => {
    const scenario = fixture();
    expect(qualityRejection(scenario)).toBeNull();
    scenario.startSnapshot.heroes[0].hp = null;
    expect(qualityRejection(scenario)).toBe('unreadable-initial-option-state');
    const empty = fixture(); empty.events = empty.events.filter(event => event.type !== 'damage');
    expect(qualityRejection(empty)).toBe('no-observed-hero-combat');
    const crowded = fixture();
    crowded.startSnapshot.heroes.push(...[4, 5].map(n => ({ ...crowded.startSnapshot.heroes[0], id: `extra-${n}` })));
    expect(qualityRejection(crowded)).toBe('more-than-four-relevant-heroes');
    expect(selectCorpus([crowded], [], 1, 'cap').selected).toHaveLength(0);
    expect(() => selectCorpus([], [crowded], 1, 'cap')).toThrow('more-than-four');
  });
  it('permits source-verified camera migration without reinterpreting saved guesses', () => {
    const old = fixture(), next = fixture();
    old.bounds.minX -= 1000;
    expect(samePuzzleIdentity(old, next)).toBe(true);
    expect(() => verifyArchivedSource(old, rawFixture(), source, now)).not.toThrow();
    expect(() => verifyAgainstReplay(old, rawFixture(), source, now)).toThrow('encounter bounds');
    next.question.answerId = 'npc_dota_hero_axe';
    expect(samePuzzleIdentity(old, next)).toBe(false);
    next.question.answerId = old.question.answerId;
    next.question.optionIds.pop();
    expect(samePuzzleIdentity(old, next)).toBe(false);
    const changed = fixture();
    changed.frames[5].heroes[0].hp = 123;
    expect(() => verifyArchivedSource(changed, rawFixture(), source, now)).toThrow('hero state');
  });
  it('verifies actual source frames/events and refuses corrupted state, identity and age', () => {
    expect(() => verifyAgainstReplay(fixture(), rawFixture(), source, now)).not.toThrow();
    const changed = fixture(); changed.frames[5].heroes[0].hp = 123;
    expect(() => verifyAgainstReplay(changed, rawFixture(), source, now)).toThrow('hero state');
    const omitted = fixture(); omitted.events = omitted.events.filter(event => event.type !== 'damage');
    expect(() => verifyAgainstReplay(omitted, rawFixture(), source, now)).toThrow('events');
    const stale = fixture(); stale.source = { ...source, matchStartTime: 1 };
    expect(() => verifyAgainstReplay(stale, rawFixture(), source, now)).toThrow('180-day');
    const unknown = fixture(); unknown.source = { ...source, matchStartTime: null };
    expect(() => verifyAgainstReplay(unknown, rawFixture(), source, now)).toThrow('unknown');
    const wrong = fixture(); wrong.source = { ...source, replaySha256: 'b'.repeat(64) };
    expect(() => verifyAgainstReplay(wrong, rawFixture(), source, now)).toThrow('identity');
  });
});

describe('published real corpus', () => {
  const catalog = catalogSchema.parse(JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')));
  const scenarios = catalog.scenarios.filter(entry => entry.kind === 'replay').map(entry =>
    scenarioSchema.parse(JSON.parse(readFileSync(`public${entry.path}`, 'utf8'))));
  it('contains exactly fifty valid recent real clips, not demo copies', () => {
    expect(scenarios).toHaveLength(50);
    expect(readdirSync('public/scenarios').filter(name => /^replay-.*\.json$/.test(name))).toHaveLength(50);
    expect(scenarios.every(scenario => scenario.source.kind === 'replay' && scenarioEligibility(scenario, Date.now()).eligible)).toBe(true);
    expect(new Set(scenarios.map(scenario => scenario.id)).size).toBe(50);
    expect(new Set(scenarios.map(outcomeKey)).size).toBe(50);
    expect(new Set(scenarios.map(scenario => scenario.source.matchId)).size).toBeGreaterThanOrEqual(10);
  });
  it('publishes at most four complete participant trajectories with hero-only framing', () => {
    for (const scenario of scenarios) {
      expect(new Set(scenario.frames.flatMap(frame => frame.heroes.map(hero => hero.id))).size).toBeLessThanOrEqual(MAX_SCENARIO_HEROES);
      expect(scenario.bounds).toEqual(encounterBounds(scenario.frames));
    }
  });

  describe('isolated batch failure and resume behavior', () => {
    it('publishes honest partial results, resumes without duplicates, and refuses corrupted cache data', async () => {
      await mkdir('.cache', { recursive: true });
      const folder = await mkdtemp(resolve('.cache/corpus-test-'));
      try {
        const cache = join(folder, '.cache');
        await mkdir(cache);
        const raw = JSON.stringify(rawFixture());
        const fixtureSource = { ...source, matchStartTime: Math.floor(Date.now() / 1000) - 60 };
        const rawPath = join(cache, `${source.replaySha256}-clarity-4.0.1-v3.json`);
        await writeFile(rawPath, raw);
        const provenancePath = join(cache, `${source.replaySha256}.provenance.json`);
        await writeFile(provenancePath, JSON.stringify({
          version: 1, replayPath: join(cache, 'explicit-unit-fixture.dem'),
          rawSha256: createHash('sha256').update(raw).digest('hex'), source: fixtureSource,
        }));
        const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('ingestion/batch.ts'), ...args], {
          cwd: folder, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
        });
        const first = run('--target', '2', '--offline');
        expect(first.status, first.stderr).toBe(2);
        const reportPath = join(folder, 'public/scenarios/corpus-report.json');
        const report = JSON.parse(await readFile(reportPath, 'utf8'));
        expect(report).toMatchObject({ status: 'partial', accepted: 1, actualPublishedRealCount: 1, networkAttempts: 0, downloadAttempts: 0 });
        const scenarioPath = join(folder, 'public/scenarios', `${report.acceptedIds[0]}.json`);
        const before = await readFile(scenarioPath, 'utf8');
        const second = run('--target', '2', '--offline');
        expect(second.status, second.stderr).toBe(2);
        expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({ accepted: 1, reused: 1, newlyAccepted: 0 });
        expect(await readFile(scenarioPath, 'utf8')).toBe(before);
        const oldCamera = JSON.parse(before);
        oldCamera.bounds.minX -= 1000;
        await writeFile(scenarioPath, JSON.stringify(oldCamera));
        const badVerification = run('--target', '1', '--offline', '--verify-only');
        expect(badVerification.status).toBe(1);
        expect(badVerification.stderr).toContain('encounter bounds');
        const migrate = run('--target', '1', '--offline');
        expect(migrate.status, migrate.stderr).toBe(0);
        expect(await readFile(scenarioPath, 'utf8')).toBe(before);
        expect(JSON.parse(await readFile(reportPath, 'utf8')).updatedScenarioIds).toEqual([oldCamera.id]);
        await writeFile(rawPath, raw + ' ');
        const corrupted = run('--target', '1', '--offline', '--verify-only');
        expect(corrupted.status).toBe(1);
        expect(corrupted.stderr).toContain('integrity mismatch');
        expect(JSON.parse(await readFile(reportPath, 'utf8')).status).toBe('failed');
        expect(await readFile(scenarioPath, 'utf8')).toBe(before);
        await writeFile(rawPath, raw);
        const outdated = JSON.parse(before);
        outdated.question.optionIds.pop();
        await writeFile(scenarioPath, JSON.stringify(outdated));
        const otherSource = { ...fixtureSource, matchId: '87654321', replaySha256: 'b'.repeat(64) };
        const otherRaw = JSON.stringify({ ...rawFixture(), matchId: otherSource.matchId });
        await writeFile(join(cache, `${otherSource.replaySha256}-clarity-4.0.1-v3.json`), otherRaw);
        await writeFile(join(cache, `${otherSource.replaySha256}.provenance.json`), JSON.stringify({
          version: 1, replayPath: join(cache, 'second-unit-fixture.dem'),
          rawSha256: createHash('sha256').update(otherRaw).digest('hex'), source: otherSource,
        }));
        const replace = run('--target', '1', '--offline');
        expect(replace.status, replace.stderr).toBe(0);
        const migratedCatalog = JSON.parse(await readFile(join(folder, 'public/scenarios/index.json'), 'utf8'));
        expect(migratedCatalog.retiredQuestionIds).toEqual([outdated.id]);
        expect(migratedCatalog.scenarios[0].id).not.toBe(outdated.id);
        const noResurrection = run('--target', '2', '--offline');
        expect(noResurrection.status, noResurrection.stderr).toBe(2);
        expect(JSON.parse(await readFile(reportPath, 'utf8')).accepted).toBe(1);
        expect(JSON.parse(await readFile(reportPath, 'utf8')).retiredQuestionIds).toEqual([outdated.id]);
      } finally { await rm(folder, { recursive: true, force: true }); }
    }, 15000);
  });
  it('has no overlapping source windows and records the real match distribution', () => {
    expect(scenarios.some((scenario, index) => scenarios.slice(index + 1).some(other => windowsConflict(scenario, other)))).toBe(false);
    const counts = new Map<string | null, number>();
    for (const scenario of scenarios) counts.set(scenario.source.matchId, (counts.get(scenario.source.matchId) ?? 0) + 1);
    expect([...counts.values()].every(count => count <= 5)).toBe(true);
    expect(catalog.daily['2026-09-21']).toBe('replay-9009355617-298767');
    expect(new Set(Object.values(catalog.daily)).size).toBeGreaterThanOrEqual(50);
  });
});
