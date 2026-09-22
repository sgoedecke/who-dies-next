import { describe, expect, it } from 'vitest';
import type { Catalog, Frame, Hero } from '../shared/scenario';
import { abilityStatus, clock, cooldown, frameAt, initials, isAuxiliaryAbility, isBonusAbility, percent, readableAbilityName, readableName, readableRecordText, scenarioPath } from './game';

const hero: Hero = {
  id: 'hero', name: 'Crystal Maiden', team: 'radiant', level: null, x: 0, y: 10,
  hp: 500, maxHp: 600, mana: 200, maxMana: 400, alive: true,
  abilities: [{ name: 'Frostbite', level: 1, cooldown: 5 }], items: [], effects: null,
};
const frame = (time: number, changes: Partial<Hero> = {}): Frame => ({ time, heroes: [{ ...hero, ...changes }] });
const scenario = { duration: 10, frames: [frame(0), frame(5, { x: 100, y: 110, hp: 300, mana: 100 }), frame(10, { x: 200, y: 150, hp: 0, alive: false })] };

describe('sampled playback', () => {
  it('interpolates only positions between living observations', () => {
    const sample = frameAt(scenario, 2.5);
    expect(sample.time).toBe(0);
    expect(sample.heroes[0]).toEqual({ ...hero, x: 50, y: 60 });
  });
  it('uses the new resource observation exactly at its sample', () => {
    const sample = frameAt(scenario, 5);
    expect(sample).toEqual(scenario.frames[1]);
    expect(sample.heroes[0].hp).toBe(300);
  });
  it('does not interpolate toward dead samples or invent a death time', () => {
    expect(frameAt(scenario, 9).heroes[0]).toEqual(scenario.frames[1].heroes[0]);
    expect(frameAt(scenario, 10).heroes[0].alive).toBe(false);
  });
  it('never invents unknown positions or health', () => {
    const partial = { duration: 10, frames: [frame(0, { x: null, y: null, hp: null }), frame(10)] };
    expect(frameAt(partial, 5).heroes[0]).toMatchObject({ x: null, y: null, hp: null });
    const disappears = { duration: 10, frames: [frame(0), frame(10, { x: null, y: null })] };
    expect(frameAt(disappears, 5).heroes[0].x).toBe(0);
    expect(frameAt(disappears, 10).heroes[0].x).toBeNull();
  });
  it('clamps playback to the continuation and leaves frames unmodified', () => {
    expect(frameAt(scenario, -10)).toEqual(scenario.frames[0]);
    expect(frameAt(scenario, 200)).toEqual(scenario.frames[2]);
    frameAt(scenario, 2.5);
    expect(scenario.frames[0].heroes[0].x).toBe(0);
  });
  it('joins hero observations by identity rather than array position', () => {
    const second = { ...hero, id: 'second', x: 100 };
    const reordered = { duration: 10, frames: [{ time: 0, heroes: [hero, second] }, { time: 10, heroes: [{ ...second, x: 200 }, { ...hero, x: 20 }] }] };
    expect(frameAt(reordered, 5).heroes.map(h => h.x)).toEqual([10, 150]);
  });
  it('steps actual hero level only at recorded snapshots and restores it when rewound', () => {
    const levels = { duration: 10, frames: [frame(0, { level: 8 }), frame(5, { level: 9 }), frame(10, { level: 10 })] };
    expect(frameAt(levels, 4.99).heroes[0].level).toBe(8);
    expect(frameAt(levels, 5).heroes[0].level).toBe(9);
    expect(frameAt(levels, 9).heroes[0].level).toBe(9);
    expect(frameAt(levels, 0).heroes[0].level).toBe(8);
    expect(frameAt({ duration: 10, frames: [frame(0, { level: null }), frame(10, { level: 9 })] }, 5).heroes[0].level).toBeNull();
  });
});

describe('published scenario selection', () => {
  const catalog: Catalog = { version: 1, daily: { '2026-01-01': 'replay' }, scenarios: [
    { id: 'alternate', title: 'Alternate replay', kind: 'replay', path: '/scenarios/alternate.json', matchStartTime: Date.parse('2026-01-01T00:00:00Z') / 1000 },
    { id: 'replay', title: 'Replay', kind: 'replay', path: '/scenarios/replay.json', matchStartTime: Date.parse('2026-01-01T00:00:00Z') / 1000 },
  ] };
  it('uses only the catalog-authorized path for a requested replay', () => {
    expect(scenarioPath(catalog, 'replay')).toBe('/scenarios/replay.json');
  });
  it('rejects missing scenarios and off-origin or traversal paths', () => {
    expect(() => scenarioPath(catalog, 'unknown')).toThrow();
    for (const path of ['https://example.com/demo.json', '//example.com/scenarios/demo.json', '/scenarios/../private.json', '/other/demo.json', '/scenarios//demo.json']) {
      expect(() => scenarioPath({ ...catalog, scenarios: [{ ...catalog.scenarios[0], path }] }, 'alternate')).toThrow();
    }
  });
});

describe('honest display formatting', () => {
  it('distinguishes unknown cooldowns from ready', () => {
    expect(cooldown(null)).toBe('Cooldown unknown');
    expect(cooldown(0)).toBe('Ready');
    expect(cooldown(3.25)).toBe('3.3s cooldown');
  });
  it('does not call level-zero abilities usable and groups only explicit bonus handles', () => {
    expect(abilityStatus(0, 0)).toBe('Unlearned');
    expect(abilityStatus(0, null)).toBe('Unlearned');
    expect(abilityStatus(null, 0)).toBe('Off cooldown');
    expect(abilityStatus(1, 0)).toBe('Off cooldown');
    expect(abilityStatus(2, null)).toBe('Cooldown unknown');
    expect(abilityStatus(2, 4)).toBe('4.0s cooldown');
    expect(isBonusAbility('special_bonus_unique_mirana_1')).toBe(true);
    expect(isBonusAbility('special_bonus_hp_200')).toBe(true);
    expect(isBonusAbility('attribute_bonus')).toBe(false);
    expect(isBonusAbility('mirana_starfall')).toBe(false);
    expect(isAuxiliaryAbility('generic_hidden')).toBe(true);
    expect(isAuxiliaryAbility('special_bonus_hp_200')).toBe(true);
    expect(isAuxiliaryAbility('attribute_bonus')).toBe(false);
    expect(isAuxiliaryAbility('mirana_starfall')).toBe(false);
  });
  it('does not turn unknown resource values into zero', () => {
    expect(percent(null, 500)).toBeNull();
    expect(percent(100, null)).toBeNull();
    expect(percent(0, 0)).toBeNull();
    expect(percent(0, 500)).toBe(0);
    expect(percent(1000, 500)).toBe(100);
  });
  it('formats times and local hero monograms', () => {
    expect(clock(125.9)).toBe('2:05');
    expect(initials('Crystal Maiden')).toBe('CM');
    expect(initials('Axe')).toBe('AX');
  });
  it('humanizes internal labels without changing already readable names', () => {
    expect(readableName('npc_dota_hero_templar_assassin')).toBe('Templar Assassin');
    expect(readableName('item_magic_wand')).toBe('Magic Wand');
    expect(readableName('modifier_stunned')).toBe('Stunned');
    expect(readableName('Phase Boots')).toBe('Phase Boots');
    expect(readableAbilityName('shredder_whirling_death', 'npc_dota_hero_shredder')).toBe('Whirling Death');
    expect(readableAbilityName('mirana_starfall', 'npc_dota_hero_mirana')).toBe('Starfall');
    expect(readableRecordText('npc_dota_hero_shredder died at 3s.', [{ id: 'npc_dota_hero_shredder', name: 'Timbersaw' }])).toBe('Timbersaw died at 3s.');
    expect(readableRecordText('At 3s.', [{ id: '3', name: 'Axe' }])).toBe('At 3s.');
  });
});
