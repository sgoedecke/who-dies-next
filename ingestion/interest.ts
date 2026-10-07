import type { Scenario } from '../shared/scenario.js';

export interface ClipFeatures {
  options: number;
  /** 0 when the answer started with the lowest HP% of the options, 1 when it had the highest. */
  answerHpRank: number;
  answerStartHp: number;
  /** HP% lead of the second-lowest option over the lowest at the start. */
  lowestGap: number;
  /** Lowest HP% any surviving option reached during the clip. */
  closestCall: number;
  deaths: number;
  casts: number;
  heroDamage: number;
}

const hpRatio = (hero: { hp: number | null; maxHp: number | null }) => hero.hp !== null && hero.maxHp ? hero.hp / hero.maxHp : 1;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function clipFeatures(scenario: Scenario): ClipFeatures {
  const heroes = new Map(scenario.startSnapshot.heroes.map(hero => [hero.id, hero]));
  const options = scenario.question.optionIds.map(id => heroes.get(id)!);
  const answerId = scenario.question.answerId;
  const ordered = [...options].sort((a, b) => hpRatio(a) - hpRatio(b));
  const rank = ordered.findIndex(hero => hero.id === answerId);
  const minimum = new Map<string, number>();
  for (const frame of scenario.frames) {
    for (const hero of frame.heroes) {
      if (hero.id === answerId || !scenario.question.optionIds.includes(hero.id) || hero.alive !== true) continue;
      minimum.set(hero.id, Math.min(minimum.get(hero.id) ?? 1, hpRatio(hero)));
    }
  }
  const team = (id: string | null) => id ? heroes.get(id)?.team : undefined;
  return {
    options: options.length,
    answerHpRank: options.length > 1 ? rank / (options.length - 1) : 0,
    answerStartHp: hpRatio(heroes.get(answerId)!),
    lowestGap: ordered.length > 1 ? hpRatio(ordered[1]) - hpRatio(ordered[0]) : 1,
    closestCall: Math.min(1, ...minimum.values()),
    deaths: new Set(scenario.events.filter(event => event.type === 'death' && event.targetId && heroes.has(event.targetId)).map(event => event.targetId)).size,
    casts: scenario.events.filter(event => (event.type === 'ability' || event.type === 'item') && event.actorId && heroes.has(event.actorId)
      && event.ability && !/^(courier_|plus_|seasonal_)/.test(event.ability)).length,
    heroDamage: scenario.events.reduce((sum, event) => sum + (event.type === 'damage' && event.value && team(event.actorId) && team(event.targetId)
      && team(event.actorId) !== team(event.targetId) ? event.value : 0), 0),
  };
}

/**
 * How watchable and non-obvious a clip is. Rewards upsets (the victim wasn't simply the
 * lowest-HP hero), near-misses, trades, larger fights and lots of spell/item usage; penalises
 * a victim who was already almost dead.
 */
export function interestScore(features: ClipFeatures): number {
  const upset = features.answerHpRank * 1.5;
  const closeCall = clamp01((0.35 - features.closestCall) / 0.35) * 2;
  const trade = features.deaths > 1 ? 1.5 : 0;
  const size = ({ 2: -1.5, 3: 0, 4: 0.6, 5: 1 } as Record<number, number>)[features.options] ?? 0;
  const action = clamp01(features.casts / 12) * 1.5 + clamp01(features.heroDamage / 2500);
  const obvious = features.answerStartHp < 0.15 && features.answerHpRank === 0 ? -2 : 0;
  const tight = features.answerHpRank === 0 ? clamp01((0.25 - features.lowestGap) / 0.25) : 0;
  return +(upset + closeCall + trade + size + action + obvious + tight).toFixed(4);
}

/**
 * Rough chance a player gets it wrong (0 easy … 1 hard). "Pick the lowest HP" is the natural first read,
 * so clips where that read works with a clear margin among few options are easy.
 */
export function difficulty(features: ClipFeatures): number {
  const lowestRead = features.answerHpRank === 0 ? clamp01((0.3 - features.lowestGap) / 0.3) * 0.35 : 0.35 + features.answerHpRank * 0.4;
  const crowd = clamp01((features.options - 2) / 3) * 0.25;
  const decoy = clamp01((0.3 - features.closestCall) / 0.3) * 0.15;
  return +clamp01(lowestRead + crowd + decoy).toFixed(4);
}
