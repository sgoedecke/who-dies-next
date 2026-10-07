import { describe, expect, it } from 'vitest';
import type { Scenario } from '../shared/scenario';
import { casts, damagePopups, deathBursts, feedRows, revealTime, strikes, trails, unitLabel, type ScenarioEvent } from './fx';

const event = (time: number, type: ScenarioEvent['type'], actorId: string | null, targetId: string | null, ability: string | null, value: number | null = null, description = `${type}: ${actorId ?? 'null'} → ${targetId ?? 'null'} (${ability ?? 'unknown'})`): ScenarioEvent =>
  ({ time, type, actorId, targetId, ability, value, description });
const heroes = new Set(['axe', 'lina']);
type Hero = Scenario['frames'][number]['heroes'][number];
const hero = (id: string, x: number, alive = true): Hero => ({
  id, name: id, team: 'radiant', level: 1, x, y: 0, hp: 100, maxHp: 100, mana: 0, maxMana: 0, alive, abilities: [], items: [], effects: [],
} as unknown as Hero);

describe('feedRows', () => {
  it('drops modifiers and auto-attacks but keeps casts, spell damage and deaths', () => {
    const rows = feedRows([
      event(0.1, 'modifier', 'axe', 'lina', 'modifier_axe_battle_hunger'),
      event(0.2, 'damage', 'axe', 'lina', 'dota_unknown', 60),
      event(0.5, 'ability', 'lina', null, 'lina_dragon_slave'),
      event(0.6, 'ability', 'axe', null, 'plus_high_five', null, 'ability: axe → dota_unknown (plus_high_five)'),
      event(0.7, 'item', 'courier', 'axe', 'courier_take_stash_and_transfer_items'),
      event(3, 'death', 'axe', 'lina', null, null, 'death: axe → lina (unknown)'),
    ], heroes, 10);
    expect(rows.map(row => row.type)).toEqual(['ability', 'death']);
  });

  it('merges a cast with the damage it deals and repeated ticks, but not beyond the window', () => {
    const rows = feedRows([
      event(1, 'ability', 'axe', 'lina', 'axe_culling_blade'),
      event(1.1, 'damage', 'axe', 'lina', 'axe_culling_blade', 200),
      event(2, 'damage', 'axe', 'lina', 'axe_culling_blade', 50),
      event(3.5, 'damage', 'axe', 'lina', 'axe_culling_blade', 10),
    ], heroes, 10);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'ability', count: 1, value: 250, lastTime: 2 });
    expect(rows[1]).toMatchObject({ type: 'damage', value: 10 });
  });

  it('hides events after the playhead and names unknown units from descriptions', () => {
    const rows = feedRows([
      event(1, 'damage', null, 'axe', 'tower_attack_spell', 30, 'damage: npc_dota_goodguys_tower1_mid → axe (tower_attack_spell)'),
      event(5, 'ability', 'axe', null, 'axe_berserkers_call'),
    ], heroes, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toEqual({ id: null, label: 'Radiant tower' });
    expect(rows[0].target).toEqual({ id: 'axe', label: 'axe' });
  });
});

describe('unitLabel', () => {
  it('summarises creeps and towers by team', () => {
    expect(unitLabel('npc_dota_creep_badguys_melee')).toBe('Dire creep');
    expect(unitLabel('npc_dota_neutral_kobold')).toBe('Neutral creep');
    expect(unitLabel('npc_dota_badguys_tower2_top')).toBe('Dire tower');
  });
});

describe('map effects', () => {
  it('buckets damage numbers per target and expires them', () => {
    const events = [
      event(1.0, 'damage', 'axe', 'lina', 'dota_unknown', 40),
      event(1.1, 'damage', 'axe', 'lina', 'dota_unknown', 45),
      event(1.2, 'damage', 'axe', 'lina', 'axe_culling_blade', 300),
      event(1.2, 'damage', 'axe', 'creep', 'dota_unknown', 99),
    ];
    const popups = damagePopups(events, heroes, 1.3);
    expect(popups.map(popup => [popup.spell, popup.amount]).sort()).toEqual([[false, 85], [true, 300]]);
    expect(damagePopups(events, heroes, 3)).toEqual([]);
  });

  it('shows only the newest strike per pair and the newest cast per hero', () => {
    const events = [
      event(1, 'damage', 'axe', 'lina', 'dota_unknown', 10),
      event(1.2, 'damage', 'axe', 'lina', 'dota_unknown', 10),
      event(1.1, 'ability', 'lina', null, 'lina_dragon_slave'),
      event(1.3, 'item', 'lina', null, 'item_blink'),
    ];
    expect(strikes(events, heroes, 1.25)).toEqual([expect.objectContaining({ actorId: 'axe', targetId: 'lina', spell: false })]);
    expect(casts(events, heroes, 1.4)).toEqual([expect.objectContaining({ actorId: 'lina', ability: 'item_blink' })]);
    expect(deathBursts([event(2, 'death', null, 'lina', null)], heroes, 2.5)).toEqual([{ targetId: 'lina', age: 0.5 }]);
  });

  it('ends trails at a death instead of bridging it', () => {
    const frames = [0, 1, 2].map(time => ({ time, heroes: [hero('axe', time * 100), hero('lina', time * 100, time < 1)] }));
    const result = trails({ frames, duration: 2 } as Pick<Scenario, 'frames' | 'duration'>, 2, 1, 0.5);
    expect(result.get('axe')!.map(point => point.x)).toEqual([200, 150, 100]);
    expect(result.get('lina')).toEqual([]);
  });
});

describe('revealTime', () => {
  const base = { duration: 10, question: { answerId: 'lina' } } as Pick<Scenario, 'duration' | 'question'>;
  it('uses the recorded death of the answer', () => {
    expect(revealTime({ ...base, frames: [], events: [event(4, 'death', null, 'axe', null), event(6.5, 'death', null, 'lina', null)] } as never)).toBe(6.5);
  });
  it('falls back to the first dead sample, then the clip end', () => {
    const frames = [0, 3].map(time => ({ time, heroes: [hero('lina', 0, time === 0)] }));
    expect(revealTime({ ...base, frames, events: [] } as never)).toBe(3);
    expect(revealTime({ ...base, frames: [], events: [] } as never)).toBe(10);
  });
});
