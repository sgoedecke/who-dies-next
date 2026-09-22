import { scenarioSchema, type Hero, type Scenario } from '../../shared/scenario.js';

// Hand-authored test data. Never imported by the application or published as replay evidence.
export function createTestScenario(): Scenario {
  const heroes: Hero[] = [
    {
      id: 'npc_dota_hero_windrunner', name: 'Windranger', team: 'radiant',
      level: 10,
      x: -400, y: -40, hp: 640, maxHp: 1200, mana: 260, maxMana: 650, alive: true,
      abilities: [{ name: 'Shackleshot', level: 3, cooldown: 0 }, { name: 'Powershot', level: 4, cooldown: 4.5 }, { name: 'Windrun', level: 2, cooldown: 7 }, { name: 'Focus Fire', level: 1, cooldown: 32 }],
      items: [{ name: 'Phase Boots', charges: null, cooldown: 0 }, { name: 'Magic Wand', charges: 8, cooldown: 0 }],
      effects: [],
    },
    {
      id: 'npc_dota_hero_axe', name: 'Axe', team: 'dire',
      level: 10,
      x: 230, y: 240, hp: 1320, maxHp: 1800, mana: 210, maxMana: 500, alive: true,
      abilities: [{ name: "Berserker's Call", level: 3, cooldown: 0 }, { name: 'Battle Hunger', level: 2, cooldown: 0 }, { name: 'Counter Helix', level: 4, cooldown: null }, { name: 'Culling Blade', level: 1, cooldown: 0 }],
      items: [{ name: 'Blink Dagger', charges: null, cooldown: 0 }, { name: 'Blade Mail', charges: null, cooldown: 15 }],
      effects: [],
    },
    {
      id: 'npc_dota_hero_lina', name: 'Lina', team: 'radiant',
      level: 9,
      x: -720, y: -420, hp: 310, maxHp: 1050, mana: 420, maxMana: 820, alive: true,
      abilities: [{ name: 'Dragon Slave', level: 4, cooldown: 0 }, { name: 'Light Strike Array', level: 2, cooldown: 0 }, { name: 'Fiery Soul', level: 2, cooldown: null }, { name: 'Laguna Blade', level: 1, cooldown: 0 }],
      items: [{ name: 'Arcane Boots', charges: null, cooldown: 18 }, { name: 'Eul’s Scepter', charges: null, cooldown: 0 }],
      effects: [],
    },
  ];
  const frames = Array.from({ length: 41 }, (_, i) => {
    const time = i / 4;
    return {
      time,
      heroes: heroes.map(h => {
        const hero = structuredClone(h);
        hero.abilities = hero.abilities.map(a => ({ ...a, cooldown: a.cooldown === null ? null : Math.max(0, a.cooldown - time) }));
        if (h.name === 'Windranger') {
          hero.x = -400 + Math.min(time, 6.5) * 62;
          hero.y = -40 + Math.min(time, 6.5) * 18;
          hero.hp = time < 2 ? 640 : time < 4 ? 410 : time < 6.5 ? 180 : 0;
          hero.alive = time < 6.5;
          hero.effects = time >= 2 && time < 4 ? ["Berserker's Call"] : [];
        } else if (h.name === 'Axe') {
          hero.x = time < 1.5 ? 230 - time * 30 : -220 + (time - 1.5) * 48;
          hero.y = time < 1.5 ? 240 : 10 + (time - 1.5) * 12;
          hero.hp = time < 3 ? 1320 : time < 5 ? 940 : 610;
          hero.mana = time < 2 ? 210 : time < 6.5 ? 130 : 30;
        } else {
          hero.x = -720 + time * 38;
          hero.y = -420 + time * 12;
          hero.mana = time < 3 ? 420 : 200;
        }
        return hero;
      }),
    };
  });
  return scenarioSchema.parse({
    schemaVersion: 1, id: 'unit-fight', title: 'Isolated test fixture',
    description: 'Three heroes. Ten seconds. Take a look at their resources before you make the call.',
    source: {
      kind: 'replay', label: 'TEST ONLY: hand-authored fixture, not a real replay',
      matchId: '00000001', patch: null, matchStartTime: 1789980832,
      matchStartTimeSource: 'Test fixture', replaySha256: '0'.repeat(64),
      parser: 'Test fixture', extractedAt: '2026-09-21T00:00:00.000Z',
      acquisition: 'TEST ONLY: never publish this fixture',
    },
    coordinateSystem: 'dota-world', bounds: { minX: -1050, maxX: 800, minY: -750, maxY: 800 },
    startTime: 0, duration: 10, sampleInterval: 0.25,
    question: {
      kind: 'first-death', prompt: 'Who dies first in the next 10 seconds?', windowSeconds: 10,
      optionIds: heroes.map(h => h.id), answerId: heroes[0].id,
      explanation: 'Hand-authored test fixture: Windranger falls at +6.5s. Not a real replay or simulation.',
    },
    startSnapshot: frames[0], frames,
    events: [
      { time: 1.5, type: 'item', actorId: heroes[1].id, targetId: null, ability: 'Blink Dagger', value: null, description: 'Axe blinks into range.' },
      { time: 2, type: 'ability', actorId: heroes[1].id, targetId: heroes[0].id, ability: "Berserker's Call", value: null, description: 'Axe catches Windranger with a call.' },
      { time: 3, type: 'ability', actorId: heroes[2].id, targetId: heroes[1].id, ability: 'Dragon Slave', value: null, description: 'Lina contributes damage from a safer distance.' },
      { time: 6.5, type: 'death', actorId: heroes[1].id, targetId: heroes[0].id, ability: 'Culling Blade', value: null, description: 'Windranger dies first. Lina survives the window.' },
    ],
    limitations: ['Entirely synthetic: positions, timings, resources, and events are authored, not downloaded or simulated.', 'Ability and item values illustrate the interface and are not validated against any Dota patch.', 'Schematic arena only. Terrain, vision, and collision are not represented.'],
  });
}
