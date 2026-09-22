import { describe, expect, it } from 'vitest';
import { scenarioSchema, rawReplaySchema, type RawReplay, type Scenario } from '../shared/scenario.js';
import { createTestScenario } from './fixtures/scenario.js';
import { extractScenarios, scanScenarios } from '../ingestion/extract.js';
import { encounterBounds, MAX_HERO_SPAN, CAMERA_MARGIN } from '../shared/encounter.js';

const source: Extract<Scenario['source'], { kind: 'replay' }> = {
  kind: 'replay', label: 'Test fixture', matchId: '12345678', patch: null,
  replaySha256: 'a'.repeat(64), parser: 'clarity 4.0.1',
  extractedAt: '2026-09-21T00:00:00.000Z', acquisition: 'Unit test, not live evidence',
  matchStartTime: 1789980832, matchStartTimeSource: 'Explicit unit-test fixture',
};
function fixture(): RawReplay {
  const demo = createTestScenario();
  return rawReplaySchema.parse({
    schemaVersion: 1, matchId: '12345678', patch: null,
    parser: { name: 'clarity', version: '4.0.1' }, coordinateSystem: 'dota-world', sampleInterval: 0.25,
    frames: [...demo.frames, ...[10.25, 10.5, 10.75, 11].map(time => ({ ...demo.frames.at(-1)!, time }))],
    events: demo.events, limitations: ['Fixture only'],
  });
}
describe('shared scenario contract', () => {
  it('validates an isolated test fixture but rejects synthetic playable sources', () => {
    const scenario = scenarioSchema.parse(createTestScenario());
    expect(scenario.source.label).toContain('TEST ONLY');
    expect(() => scenarioSchema.parse({ ...scenario, source: { kind: 'synthetic', label: 'Removed demo', matchId: null, patch: null } })).toThrow();
  });
  it('rejects more than four playable participants, without limiting raw replay rosters', () => {
    const sample = createTestScenario();
    for (const frame of sample.frames) frame.heroes.push(...[4, 5].map(n => ({ ...frame.heroes[0], id: `extra-${n}` })));
    sample.startSnapshot = sample.frames[0];
    expect(() => scenarioSchema.parse(sample)).toThrow('at most four');
    const raw = fixture();
    for (const frame of raw.frames) frame.heroes.push(...[4, 5].map(n => ({ ...frame.heroes[0], id: `extra-${n}` })));
    expect(rawReplaySchema.parse(raw).frames[0].heroes).toHaveLength(5);
  });
  it('rejects a camera that hides a known participant', () => {
    const sample = createTestScenario();
    sample.bounds.minX = 0;
    expect(() => scenarioSchema.parse(sample)).toThrow('contain all known');
  });
  it('rejects a fabricated answer', () => {
    const sample = createTestScenario();
    sample.question.answerId = 'npc_dota_hero_lina';
    expect(() => scenarioSchema.parse(sample)).toThrow('first participant death');
  });
  it('rejects same-sample ambiguous deaths', () => {
    const sample = createTestScenario();
    sample.events.push({ ...sample.events.at(-1)!, targetId: 'npc_dota_hero_lina', time: 6.6 });
    expect(() => scenarioSchema.parse(sample)).toThrow('Ambiguous');
  });
  it('rejects a missing continuation and inconsistent frozen snapshot', () => {
    const sample = createTestScenario();
    sample.frames = sample.frames.slice(0, 10);
    expect(() => scenarioSchema.parse(sample)).toThrow('whole question window');
    sample.startSnapshot = { ...sample.startSnapshot, time: 1 };
    expect(() => scenarioSchema.parse(sample)).toThrow('Start snapshot');
  });
  it('retains null state without defaulting to zero', () => {
    const sample = createTestScenario();
    sample.frames[1].heroes[0].mana = null;
    sample.frames[1].heroes[0].abilities[0].cooldown = null;
    expect(scenarioSchema.parse(sample).frames[1].heroes[0].mana).toBeNull();
  });
  it('rejects offering a dead or unknown-life hero as a prediction', () => {
    const sample = createTestScenario();
    sample.startSnapshot.heroes[0].alive = null;
    sample.frames[0].heroes[0].alive = null;
    expect(() => scenarioSchema.parse(sample)).toThrow('observed alive');
  });
});
describe('replay encounter extraction', () => {
  it('keeps observed tower state without allowing towers to expand the hero-only camera', () => {
    const raw = fixture();
    raw.mapContext = {
      towerSource: 'Test observed entities', treeSource: 'Test temporary trees',
      treeCoverage: 'temporary-only', terrainSource: null, limitations: ['No static terrain'],
    };
    for (const frame of raw.frames) {
      frame.towers = [
        { id: 'near-tower', name: 'Tower', team: 'dire', x: 1200, y: 600, z: 128, hp: frame.time < 5 ? 500 : 0, maxHp: 1800, alive: frame.time < 5 },
        { id: 'far-tower', name: 'Far tower', team: 'radiant', x: 8000, y: 8000, z: 256, hp: 1800, maxHp: 1800, alive: true },
      ];
      frame.trees = [{ id: 'tree', x: 200, y: 100, z: 128, alive: frame.time < 3 }];
    }
    const [scenario] = extractScenarios(raw, source, 1);
    expect(scenario.bounds.maxX).toBeLessThan(1200);
    expect(scenario.bounds.maxX).toBeLessThan(8000);
    expect(scenario.bounds).toEqual(encounterBounds(scenario.frames));
    expect(scenario.startSnapshot.towers).toHaveLength(1);
    expect(scenario.startSnapshot.towers![0]).toMatchObject({ x: 1200, y: 600, hp: 500, alive: true });
    expect(scenario.frames.at(-1)!.towers![0]).toMatchObject({ hp: 0, alive: false });
    expect(scenario.startSnapshot.trees![0].alive).toBe(true);
    expect(scenario.frames.at(-1)!.trees![0].alive).toBe(false);
    expect(scenario.mapContext?.terrainSource).toBeNull();
    expect(scenario.mapContext?.treeCoverage).toBe('temporary-only');
  });
  it('derives a bounded answer from events and preserves observed state', () => {
    const [scenario] = extractScenarios(fixture(), source, 1);
    expect(scenario.question.answerId).toBe('npc_dota_hero_windrunner');
    expect(scenario.startTime).toBe(0.5);
    expect(scenario.frames.at(-1)!.time).toBe(10);
    expect(scenario.events.find(e => e.type === 'death')?.time).toBe(6);
    expect(scenario.startSnapshot.heroes).toHaveLength(3);
    expect(scenario.source.kind).toBe('replay');
    expect(scenario.startSnapshot.heroes[1].abilities[2].cooldown).toBeNull();
  });
  it('rejects replays without observed death events', () => {
    const raw = fixture(); raw.events = [];
    expect(() => extractScenarios(raw, source)).toThrow('no unambiguous');
  });
  it('rejects simultaneous deaths rather than arbitrarily choosing', () => {
    const raw = fixture();
    raw.events.push({ ...raw.events.at(-1)!, targetId: 'npc_dota_hero_lina', time: 6.5 });
    expect(() => extractScenarios(raw, source)).toThrow('no unambiguous');
  });
  it('rejects missing participant samples and large timeline gaps', () => {
    const raw = fixture(); raw.frames[8].heroes = [];
    expect(() => extractScenarios(raw, source)).toThrow('no unambiguous');
    const gap = fixture(); gap.frames.splice(4, 6);
    expect(() => extractScenarios(gap, source)).toThrow('no unambiguous');
  });
  it('rejects unordered parser data', () => {
    const raw = fixture(); raw.frames.reverse();
    expect(() => extractScenarios(raw, source)).toThrow('not strictly ordered');
  });
  it('honors a source replay start threshold without changing the window semantics', () => {
    expect(extractScenarios(fixture(), source, 1, 0.5)[0].startTime).toBe(0.5);
    expect(() => extractScenarios(fixture(), source, 1, 1)).toThrow('no unambiguous');
  });
  it('never assigns one canonical ID to multiple scanned death windows', () => {
    const raw = fixture();
    raw.events.push({ ...raw.events.at(-1)! });
    const scan = scanScenarios(raw, source, { limit: 10, minStartGap: 0 });
    expect(scan.scenarios).toHaveLength(1);
    expect(scan.rejected['duplicate-source-window']).toBe(1);
  });
  it('rejects five nearby heroes instead of truncating them or the answers', () => {
    const raw = fixture();
    for (const frame of raw.frames) {
      frame.heroes.push(...[4, 5].map(n => ({ ...frame.heroes[1], id: `npc_dota_hero_extra_${n}` })));
    }
    const scan = scanScenarios(raw, source);
    expect(scan.scenarios).toHaveLength(0);
    expect(scan.rejected['more-than-four-relevant-heroes']).toBe(1);
  });
  it('closes remote interactions in both directions and rejects missing actors', () => {
    const raw = fixture();
    for (const frame of raw.frames) {
      frame.heroes.push({ ...frame.heroes[1], id: 'npc_dota_hero_remote', x: 2600, y: 0 });
    }
    raw.events.unshift({ ...raw.events[1], time: 1, actorId: 'npc_dota_hero_axe', targetId: 'npc_dota_hero_remote' });
    // This outgoing target is beyond the proximity radius, and its path makes a tight view impossible.
    expect(scanScenarios(raw, source).rejected['encounter-too-spread']).toBe(1);
    raw.events.unshift({ ...raw.events[1], time: 1.1, actorId: 'npc_dota_hero_missing', targetId: 'npc_dota_hero_remote' });
    expect(scanScenarios(raw, source).rejected['more-than-four-relevant-heroes']).toBe(1);
    const missing = fixture();
    missing.events.unshift({ ...missing.events[1], time: 1, actorId: 'npc_dota_hero_missing', targetId: missing.frames[0].heroes[0].id });
    expect(scanScenarios(missing, source).rejected['participant-missing-from-setup']).toBe(1);
  });
  it('follows chains longer than two passes without dropping a decisive fifth hero', () => {
    const raw = fixture();
    for (const frame of raw.frames) {
      frame.heroes[1].x = 4000;
      frame.heroes[2].x = 4100;
      frame.heroes.push(...[4, 5].map(n => ({ ...frame.heroes[1], id: `npc_dota_hero_remote_${n}`, x: 4200 + n })));
    }
    const ids = raw.frames[0].heroes.map(hero => hero.id);
    raw.events = [
      ...[3, 2, 1, 0].map(index => ({ ...raw.events[1], time: 1, actorId: ids[index + 1], targetId: ids[index] })),
      { ...raw.events.at(-1)!, actorId: null },
    ];
    expect(scanScenarios(raw, source).rejected['more-than-four-relevant-heroes']).toBe(1);
  });
  it('retains relevant corpses through events, but excludes inactive old corpses by proximity', () => {
    const raw = fixture();
    for (const frame of raw.frames) frame.heroes.push(...[4, 5].map(n => ({
      ...frame.heroes[1], id: `npc_dota_hero_corpse_${n}`, alive: false, hp: 0,
    })));
    expect(extractScenarios(raw, source)[0].startSnapshot.heroes).toHaveLength(3);
    raw.events.push(...[4, 5].map(n => ({
      ...raw.events[1], time: 5, actorId: `npc_dota_hero_corpse_${n}`, targetId: raw.frames[0].heroes[0].id,
    })));
    expect(scanScenarios(raw, source).rejected['more-than-four-relevant-heroes']).toBe(1);
  });
  it('keeps every recorded participant point inside a stable tight view and rejects path outliers', () => {
    const scenario = extractScenarios(fixture(), source)[0];
    for (const frame of scenario.frames) for (const hero of frame.heroes) {
      expect(hero.x!).toBeGreaterThanOrEqual(scenario.bounds.minX + CAMERA_MARGIN);
      expect(hero.x!).toBeLessThanOrEqual(scenario.bounds.maxX - CAMERA_MARGIN);
      expect(hero.y!).toBeGreaterThanOrEqual(scenario.bounds.minY + CAMERA_MARGIN);
      expect(hero.y!).toBeLessThanOrEqual(scenario.bounds.maxY - CAMERA_MARGIN);
    }
    const raw = fixture();
    raw.frames[30].heroes[0].x = 10000;
    expect(scanScenarios(raw, source).rejected['encounter-too-spread']).toBe(1);
    const unknown = fixture();
    unknown.frames[30].heroes[0].x = null;
    expect(scanScenarios(unknown, source).rejected['participant-position-unknown']).toBe(1);
    const boundary = fixture();
    for (const frame of boundary.frames) frame.heroes[1].x = -701 + MAX_HERO_SPAN;
    expect(scanScenarios(boundary, source).scenarios).toHaveLength(1);
    boundary.frames[30].heroes[1].x! += 0.01;
    expect(scanScenarios(boundary, source).rejected['encounter-too-spread']).toBe(1);
  });
});
