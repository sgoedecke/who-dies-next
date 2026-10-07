import type { Scenario } from '../shared/scenario';
import { frameAt, readableName } from './game';

/** Visual effects are derived only from recorded events; nothing here is simulated. */
export type ScenarioEvent = Scenario['events'][number];

/** Parsers record plain right-clicks without an ability name. */
export const AUTO_ATTACK = 'dota_unknown';

const isSpell = (ability: string | null) => !!ability && ability !== AUTO_ATTACK;

export interface DamagePopup { key: string; targetId: string; amount: number; spell: boolean; age: number; slot: number }

/** Hits on one participant within a short bucket merge into a single rising number. */
export function damagePopups(events: ScenarioEvent[], participants: Set<string>, time: number, life = 0.9, bucket = 0.45): DamagePopup[] {
  const groups = new Map<string, DamagePopup>();
  for (const event of events) {
    if (event.type !== 'damage' || !event.targetId || !participants.has(event.targetId)) continue;
    if (event.value === null || event.value <= 0 || event.time > time) continue;
    const slot = Math.floor(event.time / bucket);
    const age = time - slot * bucket;
    if (age >= life) continue;
    const spell = isSpell(event.ability);
    const key = `${event.targetId}:${spell ? 'spell' : 'attack'}:${slot}`;
    const group = groups.get(key);
    if (group) group.amount += event.value;
    else groups.set(key, { key, targetId: event.targetId, amount: event.value, spell, age, slot });
  }
  return [...groups.values()];
}

/** Flash intensity (0–1) for participants hit within the last `life` seconds. */
export function hitFlashes(events: ScenarioEvent[], participants: Set<string>, time: number, life = 0.3): Map<string, number> {
  const flashes = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'damage' || !event.targetId || !participants.has(event.targetId)) continue;
    const age = time - event.time;
    if (age < 0 || age >= life) continue;
    flashes.set(event.targetId, Math.max(flashes.get(event.targetId) ?? 0, 1 - age / life));
  }
  return flashes;
}

export interface Strike { key: string; actorId: string; targetId: string; spell: boolean; age: number }

/** Hero-to-hero attacks and spells, newest per pair, fading over `life` seconds. */
export function strikes(events: ScenarioEvent[], participants: Set<string>, time: number, life = 0.5): Strike[] {
  const latest = new Map<string, Strike>();
  for (const event of events) {
    if (event.type !== 'damage' && event.type !== 'ability' && event.type !== 'item') continue;
    const { actorId, targetId } = event;
    if (!actorId || !targetId || actorId === targetId || !participants.has(actorId) || !participants.has(targetId)) continue;
    const age = time - event.time;
    if (age < 0 || age >= life) continue;
    const key = `${actorId}>${targetId}`;
    const previous = latest.get(key);
    if (!previous || age < previous.age) latest.set(key, { key, actorId, targetId, spell: isSpell(event.ability), age });
  }
  return [...latest.values()];
}

export interface Cast { actorId: string; ability: string; age: number }

/** The newest recorded ability or item use per participant. */
export function casts(events: ScenarioEvent[], participants: Set<string>, time: number, life = 1.2): Cast[] {
  const latest = new Map<string, Cast>();
  for (const event of events) {
    if (event.type !== 'ability' && event.type !== 'item') continue;
    if (!event.actorId || !participants.has(event.actorId) || !isSpell(event.ability)) continue;
    const age = time - event.time;
    if (age < 0 || age >= life) continue;
    const previous = latest.get(event.actorId);
    if (!previous || age < previous.age) latest.set(event.actorId, { actorId: event.actorId, ability: event.ability!, age });
  }
  return [...latest.values()];
}

export interface DeathBurst { targetId: string; age: number }

export function deathBursts(events: ScenarioEvent[], participants: Set<string>, time: number, life = 1.6): DeathBurst[] {
  return events.flatMap(event => {
    const age = time - event.time;
    return event.type === 'death' && event.targetId && participants.has(event.targetId) && age >= 0 && age < life
      ? [{ targetId: event.targetId, age }] : [];
  });
}

/** Recent recorded positions per hero, newest first, sampled from the same interpolation as the markers. */
export function trails(scenario: Pick<Scenario, 'frames' | 'duration'>, time: number, span = 1.6, step = 0.2): Map<string, Array<{ x: number; y: number }>> {
  const result = new Map<string, Array<{ x: number; y: number }>>();
  if (time <= 0) return result;
  const stopped = new Set<string>();
  for (let index = 0; index * step <= span + 1e-9; index++) {
    const sampleTime = time - index * step;
    if (sampleTime < 0) break;
    for (const hero of frameAt(scenario, sampleTime).heroes) {
      const points = result.get(hero.id) ?? [];
      result.set(hero.id, points);
      if (stopped.has(hero.id)) continue;
      // End a trail at a death or missing sample rather than bridging it.
      if (hero.alive === false || hero.x === null || hero.y === null) stopped.add(hero.id);
      else points.push({ x: hero.x, y: hero.y });
    }
  }
  return result;
}

export interface Unit { id: string | null; label: string }

/** Readable label for a non-participant unit id taken from a record description. */
export function unitLabel(raw: string): string {
  if (/creep_goodguys/.test(raw)) return 'Radiant creep';
  if (/creep_badguys/.test(raw)) return 'Dire creep';
  if (/neutral/.test(raw)) return 'Neutral creep';
  if (/goodguys_tower|tower.*goodguys/.test(raw)) return 'Radiant tower';
  if (/badguys_tower|tower.*badguys/.test(raw)) return 'Dire tower';
  if (/tower/.test(raw)) return 'Tower';
  return readableName(raw.replace(/^npc_dota_/, ''));
}

/** Couriers and cosmetic emotes (e.g. High Five) say nothing about the fight. */
const isFeedNoise = (ability: string | null) => !!ability && /^(courier_|plus_|seasonal_)/.test(ability);

const recordPattern = /^\w+: (\S+) → (\S+) \(([^)]+)\)$/;

export interface FeedRow {
  key: string;
  time: number;
  type: ScenarioEvent['type'];
  event: ScenarioEvent;
  actor: Unit | null;
  target: Unit | null;
  ability: string | null;
  /** Total recorded damage merged into this row. */
  value: number | null;
  count: number;
  lastTime: number;
}

/**
 * Readable fight log: deaths, abilities, items and spell damage. Auto-attacks and modifier
 * bookkeeping are left to the map; repeated ticks of one spell on one target merge.
 */
export function feedRows(events: ScenarioEvent[], participants: Set<string>, time: number, mergeWindow = 1): FeedRow[] {
  const rows: FeedRow[] = [];
  const visible = events.filter(event => event.time <= time).sort((a, b) => a.time - b.time);
  for (const event of visible) {
    if (event.type === 'modifier' || isFeedNoise(event.ability)) continue;
    if (event.type === 'damage' && (!isSpell(event.ability)
      || !((event.targetId && participants.has(event.targetId)) || (event.actorId && participants.has(event.actorId))))) continue;
    const parsed = recordPattern.exec(event.description);
    const unit = (id: string | null, raw: string | undefined): Unit | null => {
      if (id) return { id: participants.has(id) ? id : null, label: participants.has(id) ? id : unitLabel(id) };
      if (!raw || raw === 'null' || raw === 'unknown' || raw === AUTO_ATTACK) return null;
      return participants.has(raw) ? { id: raw, label: raw } : { id: null, label: unitLabel(raw) };
    };
    const actor = unit(event.actorId, parsed?.[1]);
    const target = event.targetId === event.actorId && event.type !== 'death' ? null : unit(event.targetId, parsed?.[2]);
    const ability = isSpell(event.ability) ? event.ability : null;
    // A cast and the damage it deals share one row; deaths never merge.
    const key = `${ability ? 'spell' : event.type}|${actor?.label}|${target?.label}|${ability}`;
    const damage = event.type === 'damage' ? event.value : null;
    let previous: FeedRow | undefined;
    if (event.type !== 'death') {
      for (let index = rows.length - 1; index >= 0 && !previous; index--) {
        if (rows[index].key.startsWith(`${key}@`) && event.time - rows[index].lastTime <= mergeWindow) previous = rows[index];
      }
    }
    if (previous) {
      if (event.type === previous.type) previous.count++;
      previous.lastTime = event.time;
      if (damage !== null) previous.value = (previous.value ?? 0) + damage;
      continue;
    }
    rows.push({ key: `${key}@${rows.length}`, time: event.time, type: event.type, event, actor, target, ability, value: damage, count: 1, lastTime: event.time });
  }
  return rows;
}

export function deathTimes(events: ScenarioEvent[], participants: Set<string>): Array<{ targetId: string; time: number }> {
  return events.filter(event => event.type === 'death' && event.targetId && participants.has(event.targetId))
    .map(event => ({ targetId: event.targetId!, time: event.time }));
}

/** When the answer becomes known: the answer's recorded death, else its first dead sample, else the clip end. */
export function revealTime(scenario: Pick<Scenario, 'events' | 'frames' | 'duration' | 'question'>): number {
  const answer = scenario.question.answerId;
  const death = scenario.events.find(event => event.type === 'death' && event.targetId === answer);
  if (death) return Math.min(death.time, scenario.duration);
  const sample = scenario.frames.find(frame => frame.heroes.some(hero => hero.id === answer && hero.alive === false));
  return Math.min(sample?.time ?? scenario.duration, scenario.duration);
}
