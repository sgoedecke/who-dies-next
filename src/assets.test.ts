import { describe, expect, it } from 'vitest';
import { createElement as h, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Asset, AssetManifest } from '../shared/assets';
import { AbilityLabel, AssetContext, displayHeroName, HeroPortrait, ItemArtwork, ItemLabel, MapPortrait, localImagePath, parseAssetManifest } from './assets';
import type { Hero } from '../shared/scenario';

const art: Asset = { id: 1, name: 'npc_dota_hero_axe', label: 'Axe', path: '/assets/heroes/axe.png', url: 'https://example.com/axe.png', status: 'downloaded', aliases: ['Axe'] };
const item: Asset = { ...art, name: 'item_blink', label: 'Blink Dagger', path: '/assets/items/blink.png', aliases: ['Blink Dagger'] };
const counts = { total: 1, downloaded: 1, missing: 0 };
const manifest: AssetManifest = {
  schemaVersion: 1, generatedAt: '2026-09-21T00:00:00Z', sources: [], heroes: { npc_dota_hero_axe: art }, items: { item_blink: item },
  abilities: {},
  summary: { heroes: counts, heroIcons: counts, items: counts, abilities: counts, uniqueImages: counts, cachedImages: 0, itemImageAliases: 0, unsupportedAbilities: 0 },
  missing: [], unsupported: [],
};
const hero: Hero = { id: 'npc_dota_hero_axe', name: 'Axe', team: 'dire', level: null, x: 1, y: 1, alive: true, hp: 500, maxHp: 500, mana: null, maxMana: null, abilities: [], items: [], effects: null };

describe('optional local asset manifest', () => {
  it('accepts the published contract and rejects invalid resolver input', () => {
    expect(parseAssetManifest(manifest)?.heroes.npc_dota_hero_axe.path).toBe(art.path);
    for (const value of [null, {}, { ...manifest, schemaVersion: 2 }, { ...manifest, heroes: null }, { ...manifest, heroes: { axe: { ...art, aliases: null } } }]) {
      expect(parseAssetManifest(value)).toBeNull();
    }
  });
  it('uses only downloaded local images, never remote URLs', () => {
    expect(localImagePath(art)).toBe('/assets/heroes/axe.png');
    expect(localImagePath({ ...art, status: 'missing' })).toBeNull();
    expect(localImagePath(null)).toBeNull();
    for (const path of [null, art.url, '//example.com/axe.png', '/assets/../axe.png', '/assets//axe.png', '/private/axe.png', '/assets/axe.svg']) {
      expect(localImagePath({ ...art, path })).toBeNull();
    }
  });
  it('renders hero and item images with accessible names from canonical IDs or aliases', () => {
    const html = renderToStaticMarkup(h(AssetContext.Provider, { value: manifest }, h(HeroPortrait, { hero }), h(ItemArtwork, { name: 'Blink Dagger' })));
    expect(html).toContain('src="/assets/heroes/axe.png"');
    expect(html).toContain('alt="Axe portrait"');
    expect(html).toContain('src="/assets/items/blink.png"');
    expect(html).toContain('alt="Blink Dagger item icon"');
    expect(html).not.toContain('https://example.com');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('overflow:hidden;width:36px;height:36px');
    expect(html).toContain('max-width:100%');
  });
  it('keeps team identity and fallback monograms without a manifest', () => {
    const html = renderToStaticMarkup(h(Fragment, null, h(HeroPortrait, { hero }), h(ItemArtwork, { name: 'Unknown Item' })));
    expect(html).toContain('portrait dire');
    expect(html).toContain('>AX<');
    expect(html).toContain('>UI<');
    expect(html).not.toContain('<img');
  });
  it('uses clipped portraits on the map and preserves explicit death overlays', () => {
    const html = renderToStaticMarkup(h(AssetContext.Provider, { value: manifest }, h('svg', null, h(MapPortrait, { hero: { ...hero, alive: false } }))));
    expect(html).toContain('href="/assets/heroes/axe.png"');
    expect(html).toContain('aria-label="Axe portrait"');
    expect(html).toContain('<clipPath');
    expect(html).toContain('death-cross');
  });
  it('shows readable item labels without losing unknown item names', () => {
    expect(renderToStaticMarkup(h(AssetContext.Provider, { value: manifest }, h(ItemLabel, { name: 'item_blink' })))).toBe('Blink Dagger');
    expect(renderToStaticMarkup(h(ItemLabel, { name: 'Unknown item' }))).toBe('Unknown item');
  });
  it('uses metadata hero labels rather than internal replay entity names', () => {
    const timbersaw = { ...art, name: 'npc_dota_hero_shredder', label: 'Timbersaw', aliases: ['shredder'] };
    const replayHero = { id: timbersaw.name, name: timbersaw.name };
    expect(displayHeroName({ ...manifest, heroes: { [timbersaw.name]: timbersaw } }, replayHero)).toBe('Timbersaw');
    expect(displayHeroName(null, { id: 'npc_dota_hero_templar_assassin', name: 'npc_dota_hero_templar_assassin' })).toBe('Templar Assassin');
  });
  it('prefers real ability metadata labels and humanizes missing ones', () => {
    const metadata = { ...manifest, abilities: { mirana_arrow: { ...art, name: 'mirana_arrow', label: 'Sacred Arrow' } } };
    expect(renderToStaticMarkup(h(AssetContext.Provider, { value: metadata }, h(AbilityLabel, { name: 'mirana_arrow', heroId: 'npc_dota_hero_mirana' })))).toBe('Sacred Arrow');
    expect(renderToStaticMarkup(h(AbilityLabel, { name: 'shredder_whirling_death', heroId: 'npc_dota_hero_shredder' }))).toBe('Whirling Death');
  });
});
