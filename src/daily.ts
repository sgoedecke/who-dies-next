import type { Catalog, Hero } from '../shared/scenario';

export const DAILY_COUNT = 5;
/** Puzzle #1. */
export const DAILY_EPOCH = '2026-10-07';
export const SHARE_URL = 'https://sgoedecke.github.io/who-dies-next';

type Entry = Catalog['scenarios'][number];
export type HeroRef = Pick<Hero, 'id' | 'name' | 'team'>;
export interface DailyResult { id: string; correct: boolean; picked: HeroRef; answer: HeroRef }

/** The player's calendar day, so the puzzle turns over at their local midnight. */
export function localDay(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

export function puzzleNumber(day: string): number {
  return dayNumber(day) - dayNumber(DAILY_EPOCH) + 1;
}

export function msUntilNextDay(now = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const matchOf = (id: string) => /^replay-(\d+)-/.exec(id)?.[1] ?? id;

/**
 * Everyone gets the same five clips on a given day. The pool is dealt out in seeded shuffles so
 * no clip repeats until every clip has been used, and a day avoids repeating a match when it can.
 */
export function dailyIds(entries: Entry[], day: string, count = DAILY_COUNT): string[] {
  const pool = entries.map(entry => entry.id).sort();
  if (pool.length <= count) return pool;
  const daysPerCycle = Math.floor(pool.length / count);
  const index = dayNumber(day) - dayNumber(DAILY_EPOCH);
  const cycle = Math.floor(index / daysPerCycle);
  const within = ((index % daysPerCycle) + daysPerCycle) % daysPerCycle;
  const random = seeded(cycle * 2654435761 + 97);
  const shuffle = <T,>(items: T[]) => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  };
  // Group clips by match, then deal round-robin: a match's clips land on consecutive (distinct) days.
  const byMatch = new Map<string, string[]>();
  for (const id of pool) byMatch.set(matchOf(id), [...(byMatch.get(matchOf(id)) ?? []), id]);
  const dealt = shuffle([...byMatch.values()]).flatMap(group => shuffle(group)).slice(0, daysPerCycle * count);
  const order = shuffle(Array.from({ length: daysPerCycle }, (_, dayIndex) => dayIndex));
  return shuffle(dealt.filter((_, position) => position % daysPerCycle === order[within]));
}

const storageKey = (day: string) => `who-dies-next:daily:${day}`;

export function loadProgress(day: string, ids: string[]): DailyResult[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(day)) ?? '[]') as DailyResult[];
    if (!Array.isArray(parsed)) return [];
    // Only trust results that line up with today's clips in order.
    const results: DailyResult[] = [];
    for (const [index, result] of parsed.entries()) {
      if (result?.id !== ids[index] || typeof result.correct !== 'boolean' || !result.picked || !result.answer) break;
      results.push(result);
    }
    return results;
  } catch {
    return [];
  }
}

export function saveProgress(day: string, results: DailyResult[]): void {
  try {
    localStorage.setItem(storageKey(day), JSON.stringify(results));
  } catch {
    // Storage can be unavailable (private mode, quota); the game still works for this visit.
  }
}

export const resultEmoji = (correct: boolean) => correct ? '🟩' : '🟥';

export function shareText(day: string, results: DailyResult[], count = DAILY_COUNT): string {
  const score = results.filter(result => result.correct).length;
  const squares = Array.from({ length: count }, (_, index) => results[index] ? resultEmoji(results[index].correct) : '⬜').join('');
  return `Who dies next? #${puzzleNumber(day)} ${score}/${count}\n${squares}\n${SHARE_URL}`;
}
