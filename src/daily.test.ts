import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { catalogSchema } from '../shared/scenario';
import { DAILY_COUNT, dailyIds, loadProgress, localDay, msUntilNextDay, puzzleNumber, saveProgress, shareText, type DailyResult } from './daily';

const catalog = catalogSchema.parse(JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')));
const entries = catalog.scenarios;
const days = (start: string, count: number) => Array.from({ length: count }, (_, index) => {
  const date = new Date(`${start}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
});
const hero = (id: string) => ({ id, name: id, team: 'radiant' as const });
const result = (id: string, correct: boolean): DailyResult => ({ id, correct, picked: hero('axe'), answer: hero(correct ? 'axe' : 'lina') });

describe('daily selection', () => {
  it('is stable for a day and independent of catalog order', () => {
    expect(dailyIds(entries, '2026-10-07')).toEqual(dailyIds([...entries].reverse(), '2026-10-07'));
    expect(dailyIds(entries, '2026-10-07')).toHaveLength(DAILY_COUNT);
  });

  it('uses every clip at most once per cycle and orders each day easy to hard', () => {
    const cycle = Math.floor(entries.length / DAILY_COUNT);
    const hardness = new Map(entries.map(entry => [entry.id, entry.difficulty ?? 0.5]));
    const used = days('2026-10-07', cycle).flatMap(day => {
      const ids = dailyIds(entries, day);
      const levels = ids.map(id => hardness.get(id)!);
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
      return ids;
    });
    expect(new Set(used).size).toBe(cycle * DAILY_COUNT);
    expect(dailyIds(entries, days('2026-10-07', cycle + 1)[cycle])).toHaveLength(DAILY_COUNT);
  });

  it('gives each day one clip from each difficulty tier', () => {
    const tiered = Array.from({ length: 20 }, (_, index) => ({ ...entries[0], id: `replay-${index % 7}-${index}`, difficulty: index / 20 }));
    for (const day of days('2026-10-07', 4)) {
      const levels = dailyIds(tiered, day).map(id => Math.floor(Number(id.split('-')[2]) / 4));
      expect(levels).toEqual([0, 1, 2, 3, 4]);
    }
  });

  it('numbers puzzles from launch day', () => {
    expect(puzzleNumber('2026-10-07')).toBe(1);
    expect(puzzleNumber('2026-11-07')).toBe(32);
  });

  it('uses local calendar days and counts down to local midnight', () => {
    const evening = new Date(2026, 9, 7, 23, 30, 0);
    expect(localDay(evening)).toBe('2026-10-07');
    expect(msUntilNextDay(evening)).toBe(30 * 60 * 1000);
  });
});

describe('progress and sharing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores only results matching the day’s clips in order', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
    saveProgress('2026-10-07', [result('a', true), result('x', false)]);
    expect(loadProgress('2026-10-07', ['a', 'b', 'c'])).toEqual([result('a', true)]);
    expect(loadProgress('2026-10-08', ['a'])).toEqual([]);
  });

  it('survives unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => saveProgress('2026-10-07', [result('a', true)])).not.toThrow();
    expect(loadProgress('2026-10-07', ['a'])).toEqual([]);
  });

  it('shares five emoji squares, the score and the site link', () => {
    const results = [true, false, true, true, false].map((correct, index) => result(String(index), correct));
    expect(shareText('2026-10-09', results)).toBe('Who dies next? #3 3/5\n🟩🟥🟩🟩🟥\nhttps://sgoedecke.github.io/who-dies-next');
  });
});
