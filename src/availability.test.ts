import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { MAX_MATCH_AGE_SECONDS, scenarioEligibility } from '../shared/recent';
import { catalogSchema, scenarioSchema } from '../shared/scenario';
import type { Catalog } from '../shared/scenario';
import { availabilityLabel, catalogEntryAvailability, eligiblePracticeEntries, randomPracticeId } from './availability';

const now = Date.parse('2026-09-21T12:00:00Z');
const start = Math.floor(now / 1000);
const entry: Catalog['scenarios'][number] = { id: 'replay', title: 'Replay', kind: 'replay', path: '/scenarios/replay.json', matchStartTime: start };
const alternative: Catalog['scenarios'][number] = { ...entry, id: 'alternative', path: '/scenarios/alternative.json' };

describe('published replay availability', () => {
  it('accepts exactly the rolling 180-day boundary and rejects older matches', () => {
    expect(catalogEntryAvailability({ ...entry, matchStartTime: start - MAX_MATCH_AGE_SECONDS }, now).eligible).toBe(true);
    expect(catalogEntryAvailability({ ...entry, matchStartTime: start - MAX_MATCH_AGE_SECONDS - 1 }, now).eligible).toBe(false);
    expect(availabilityLabel({ ...entry, matchStartTime: start - MAX_MATCH_AGE_SECONDS - 1 }, now)).toBe('Unavailable — older than 180 days');
  });
  it('keeps unknown and future timestamps unavailable and explicit', () => {
    for (const matchStartTime of [null, undefined]) {
      expect(catalogEntryAvailability({ ...entry, matchStartTime }, now).eligible).toBe(false);
      expect(availabilityLabel({ ...entry, matchStartTime }, now)).toBe('Unavailable — match age unknown');
    }
    expect(availabilityLabel({ ...entry, matchStartTime: start + 1 }, now)).toBe('Unavailable — future match timestamp');
    expect(availabilityLabel(entry, now)).toBe('Recent replay');
  });
  it('rejects a legacy synthetic catalog instead of providing a demo fallback', () => {
    expect(catalogSchema.safeParse({ version: 1, daily: {}, scenarios: [
      { id: 'legacy', title: 'Removed demo', kind: 'synthetic', path: '/scenarios/legacy.json' },
    ] }).success).toBe(false);
  });
  it('does not let recent catalog metadata certify missing or stale source timestamps', () => {
    expect(catalogEntryAvailability(entry, now).eligible).toBe(true);
    expect(scenarioEligibility({ source: { kind: 'replay', matchStartTime: null } }, now).eligible).toBe(false);
    expect(scenarioEligibility({ source: { kind: 'replay', matchStartTime: start - MAX_MATCH_AGE_SECONDS - 1 } }, now).eligible).toBe(false);
  });
  it('rejects stale and unknown timestamps after parsing actual published replay JSON', () => {
    const catalog = catalogSchema.parse(JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')));
    const published = catalog.scenarios.find(candidate => candidate.kind === 'replay');
    if (!published) throw new Error('Expected the shipped real replay fixture');
    const raw = JSON.parse(readFileSync(`public${published.path}`, 'utf8'));
    for (const matchStartTime of [start - 181 * 86400, null]) {
      const parsed = scenarioSchema.parse({ ...raw, source: { ...raw.source, matchStartTime } });
      const status = scenarioEligibility(parsed, now);
      expect(status.eligible).toBe(false);
      expect(status.message).toMatch(matchStartTime === null ? /Match age is unknown/ : /outside the rolling 180-day window/);
    }
  });
  it('ignores legacy daily pins when forming the random eligible pool', () => {
    const stale = { ...entry, matchStartTime: start - MAX_MATCH_AGE_SECONDS - 1 };
    const catalog: Catalog = { version: 1, scenarios: [stale, alternative], daily: { '2026-09-21': stale.id } };
    expect(eligiblePracticeEntries(catalog, now).map(entry => entry.id)).toEqual([alternative.id]);
    expect(eligiblePracticeEntries({ ...catalog, scenarios: [stale] }, now)).toEqual([]);
  });
  it('navigates eligible real entries only, preserving catalog order and excluding rejected sources', () => {
    const next = { ...entry, id: 'next' };
    const catalog: Catalog = { version: 1, daily: {}, scenarios: [
      entry, { ...entry, id: 'old', matchStartTime: start - MAX_MATCH_AGE_SECONDS - 1 },
      { ...entry, id: 'unknown', matchStartTime: null }, { ...entry, id: 'future', matchStartTime: start + 1 }, next,
    ] };
    expect(eligiblePracticeEntries(catalog, now).map(entry => entry.id)).toEqual(['replay', 'next']);
    expect(eligiblePracticeEntries(catalog, now, ['replay']).map(entry => entry.id)).toEqual(['next']);
    expect(eligiblePracticeEntries(catalog, now, ['replay', 'next'])).toEqual([]);
  });
  it('selects uniformly from all alternatives without selecting the current scenario', () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({ ...entry, id: `replay-${index}` }));
    const selected = Array.from({ length: 49 }, (_, index) => randomPracticeId(entries, 'replay-25', () => (index + 0.5) / 49));
    expect(selected).toEqual(entries.filter(entry => entry.id !== 'replay-25').map(entry => entry.id));
    expect(new Set(selected).size).toBe(49);
    expect(randomPracticeId(entries, 'replay-0', () => 0)).toBe('replay-1');
    expect(randomPracticeId(entries, 'replay-0', () => 0.999)).toBe('replay-49');
  });
  it('handles direct links outside the practice pool and empty or singleton catalogs', () => {
    expect(randomPracticeId([], 'unavailable')).toBeNull();
    expect(randomPracticeId([entry], entry.id)).toBeNull();
    expect(randomPracticeId([entry], alternative.id)).toBe(entry.id);
  });
});
