import type { Catalog, Frame, Hero, Scenario } from '../shared/scenario';

/** Only positions interpolate; every other observation belongs to the last sample. */
export function frameAt(scenario: Pick<Scenario, 'frames' | 'duration'>, time: number): Frame {
  const t = Math.max(0, Math.min(time, scenario.duration));
  const frames = scenario.frames;
  let index = 0;
  while (index + 1 < frames.length && frames[index + 1].time <= t) index++;
  const current = frames[index];
  const next = frames[index + 1];
  if (!next || current.time === t) return current;
  const fraction = (t - current.time) / (next.time - current.time);
  return {
    ...current,
    heroes: current.heroes.map(hero => {
      const after = next.heroes.find(h => h.id === hero.id);
      if (!after || hero.alive === false || after.alive === false
        || hero.x === null || hero.y === null || after.x === null || after.y === null) return hero;
      return { ...hero, x: hero.x + (after.x - hero.x) * fraction, y: hero.y + (after.y - hero.y) * fraction };
    }),
  };
}

export function percent(value: number | null, max: number | null): number | null {
  if (value === null || max === null || max <= 0) return null;
  return Math.max(0, Math.min(100, value / max * 100));
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words.map(word => word[0]).slice(0, 2).join('').toUpperCase() : name.slice(0, 2).toUpperCase();
}

export function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export const cooldown = (seconds: number | null) => seconds === null ? 'Cooldown unknown' : seconds === 0 ? 'Ready' : `${seconds.toFixed(1)}s cooldown`;

export function abilityStatus(level: number | null, seconds: number | null): string {
  if (level === 0) return 'Unlearned';
  if (seconds === 0) return 'Off cooldown';
  return cooldown(seconds);
}

export function isBonusAbility(name: string): boolean {
  return name.startsWith('special_bonus_');
}

export function isAuxiliaryAbility(name: string): boolean {
  return name === 'generic_hidden' || isBonusAbility(name);
}

export function heroName(heroes: Hero[], id: string): string {
  return heroes.find(hero => hero.id === id)?.name ?? 'Unknown hero';
}

export function readableRecordText(text: string, heroes: Pick<Hero, 'id' | 'name'>[]): string {
  return heroes.reduce((value, hero) => hero.id.startsWith('npc_dota_hero_') ? value.replaceAll(hero.id, hero.name) : value, text);
}

export function readableName(name: string): string {
  if (!name.includes('_')) return name;
  return name.replace(/^(npc_dota_hero_|item_|modifier_)/, '').split('_').filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function readableAbilityName(name: string, heroId: string): string {
  const prefix = `${heroId.replace(/^npc_dota_hero_/, '')}_`;
  const label = readableName(name.startsWith(prefix) ? name.slice(prefix.length) : name);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface MapViewport { left: number; top: number; width: number; height: number }
export const MAP_VIEWPORT: MapViewport = { left: 55, top: 55, width: 650, height: 380 };

export function worldToScreen(bounds: Scenario['bounds'], x: number | null, y: number | null,
  viewport: MapViewport = MAP_VIEWPORT): { x: number; y: number } | null {
  if (x === null || y === null) return null;
  return {
    x: viewport.left + (x - bounds.minX) / (bounds.maxX - bounds.minX) * viewport.width,
    y: viewport.top + viewport.height - (y - bounds.minY) / (bounds.maxY - bounds.minY) * viewport.height,
  };
}

export function scenarioPath(catalog: Catalog, id: string): string {
  const entry = catalog.scenarios.find(s => s.id === id);
  if (!entry) throw new Error('This scenario is not in the published catalog.');
  // Catalog data may only load scenario JSON from this origin and directory.
  if (!/^\/scenarios\/[a-zA-Z0-9_/-]+\.json$/.test(entry.path) || entry.path.includes('//')) {
    throw new Error('The scenario has an invalid data path.');
  }
  return entry.path;
}
