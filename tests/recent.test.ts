import { describe, expect, it } from 'vitest';
import { assertRecentMatch, matchEligibility, MAX_MATCH_AGE_SECONDS, scenarioEligibility } from '../shared/recent.js';
import { heroSchema, scenarioSchema } from '../shared/scenario.js';
import { createTestScenario } from './fixtures/scenario.js';

const now = Date.parse('2026-09-21T10:00:00Z');
const nowSeconds = now / 1000;
const boundary = nowSeconds - MAX_MATCH_AGE_SECONDS;

describe('rolling 180-day match eligibility', () => {
  it('accepts the exact boundary and rejects one second older', () => {
    expect(matchEligibility(boundary, now).eligible).toBe(true);
    expect(matchEligibility(boundary - 1, now)).toMatchObject({ eligible: false, reason: 'too-old' });
    expect(matchEligibility(boundary + 1, now).eligible).toBe(true);
  });
  it('rejects unknown, invalid and future match starts explicitly', () => {
    for (const value of [undefined, null, NaN, Infinity, 0, -1, 1.5]) {
      expect(matchEligibility(value, now)).toMatchObject({ eligible: false, reason: 'unknown-age' });
    }
    expect(matchEligibility(nowSeconds + 1, now)).toMatchObject({ eligible: false, reason: 'future-start' });
  });
  it('rejects stale or unknown real imports rather than using the download date', () => {
    expect(() => assertRecentMatch(null, 'Local replay', now)).toThrow('Match age is unknown');
    expect(() => assertRecentMatch(boundary - 1, 'Imported replay', now)).toThrow('outside the rolling 180-day');
    expect(scenarioEligibility({ source: { kind: 'replay', matchStartTime: boundary - 1 } }, now).eligible).toBe(false);
  });
  it('requires a verified date for every playable source', () => {
    const fixture = createTestScenario();
    fixture.source.matchStartTime = null;
    expect(scenarioEligibility(fixture, now).eligible).toBe(false);
  });
  it('expires previously eligible content as the clock advances', () => {
    expect(matchEligibility(boundary, now).eligible).toBe(true);
    expect(matchEligibility(boundary, now + 1000).eligible).toBe(false);
  });
});

describe('observed hero levels', () => {
  it('keeps an observed zero distinct from unavailable level data', () => {
    const hero = createTestScenario().startSnapshot.heroes[0];
    expect(heroSchema.parse({ ...hero, level: 0 }).level).toBe(0);
    expect(heroSchema.parse({ ...hero, level: null }).level).toBeNull();
    expect(() => heroSchema.parse({ ...hero, level: -1 })).toThrow();
    expect(() => heroSchema.parse({ ...hero, level: 1.5 })).toThrow();
  });
  it('preserves a level-up in continuation without altering the frozen start', () => {
    const sample = createTestScenario();
    const initialLevel = sample.startSnapshot.heroes[1].level!;
    for (const frame of sample.frames.filter(f => f.time >= 5)) frame.heroes[1].level = initialLevel + 1;
    const scenario = scenarioSchema.parse(sample);
    expect(scenario.startSnapshot.heroes[1].level).toBe(initialLevel);
    expect(scenario.frames.at(-1)!.heroes[1].level).toBe(initialLevel + 1);
  });
});
