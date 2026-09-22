import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Hero } from '../shared/scenario';
import { HeroHUD } from './HeroHUD';

const hero: Hero = {
  id: 'npc_dota_hero_mirana', name: 'Mirana', team: 'radiant', level: 12,
  x: 0, y: 0, hp: 750, maxHp: 1000, mana: 100, maxMana: 400, alive: true,
  abilities: [
    { name: 'mirana_starfall', level: 3, cooldown: 4.5 },
    { name: 'mirana_arrow', level: 0, cooldown: 0 },
    { name: 'mirana_leap', level: null, cooldown: null },
    { name: 'special_bonus_unique_mirana_1', level: 0, cooldown: 0 },
    { name: 'generic_hidden', level: 0, cooldown: 0 },
  ],
  items: [{ name: 'item_magic_wand', charges: 8, cooldown: 7 }, { name: 'item_branches', charges: null, cooldown: null }],
  effects: [],
};

describe('compact observed hero HUD', () => {
  it('renders vitals with explicit values, adjacent observed groups, and inspectable icon slots', () => {
    const html = renderToStaticMarkup(h(HeroHUD, { hero }));
    expect(html).toContain('aria-label="HP: 750 / 1000"');
    expect(html).toContain('aria-label="Hero level 12"');
    expect(html).toContain('aria-label="Mana: 100 / 400"');
    expect(html).toContain('aria-label="Observed abilities"');
    expect(html).toContain('aria-label="Observed inventory"');
    expect(html).toContain('aria-label="Inspect Starfall, level 3, 4.5s cooldown"');
    expect(html).toContain('aria-label="Inspect Magic Wand, 7.0s cooldown, 8 charges"');
    expect(html).toContain('hud-slot-shade');
    expect(html).toContain('>4.5<');
    expect(html).not.toContain('Backpack');
    expect(html).not.toContain('Neutral slot');
  });
  it('does not label unlearned or unknown abilities ready and keeps talents collapsed', () => {
    const html = renderToStaticMarkup(h(HeroHUD, { hero }));
    expect(html).toContain('Inspect Arrow, level 0, Unlearned');
    expect(html).toContain('Inspect Leap, level unknown, Cooldown unknown');
    expect(html).not.toContain('Arrow, level 0, Ready');
    expect(html).toContain('More (2)');
    expect(html).toContain('title="Observed talent and hidden ability entries"');
    expect(html).not.toContain('aria-label="Inspect Generic Hidden');
    expect(html).toContain('Generic Hidden');
    expect(html).not.toContain('<details open');
    expect(html).toContain('data-ability-level="3" aria-hidden="true">Lv 3');
    expect(html).toContain('data-ability-level="0" aria-hidden="true">Lv 0');
    expect(html).toContain('data-ability-level="unknown" aria-hidden="true">Lv ?');
    expect(html.match(/class="hud-slot-level"/g)).toHaveLength(3);
    expect(html).toContain('level-unknown');
    expect(html).toContain('unlearned-shade');
  });
  it('renders missing resources and collections without inventing hero level or inventory slots', () => {
    const html = renderToStaticMarkup(h(HeroHUD, { hero: { ...hero, level: null, hp: null, maxHp: null, mana: null, maxMana: null, abilities: [], items: [], effects: null } }));
    expect(html).toContain('HP: Unknown / ?');
    expect(html).toContain('Mana: Unknown / ?');
    expect(html).toContain('Items not observed');
    expect(html).not.toContain('class="hud-slot ');
    expect(html).toContain('aria-label="Hero level unknown"');
    expect(html).not.toContain('Observed effects');
    expect(html).not.toContain('Effects unknown');
    expect(html).not.toContain('class="effects"');
  });
  it('preserves an observed hero level zero rather than substituting unknown', () => {
    const html = renderToStaticMarkup(h(HeroHUD, { hero: { ...hero, level: 0 } }));
    expect(html).toContain('aria-label="Hero level 0"');
    expect(html).not.toContain('aria-label="Hero level unknown"');
  });
});
