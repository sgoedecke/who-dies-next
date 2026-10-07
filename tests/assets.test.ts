import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAbilityAsset, resolveHeroAsset, resolveItemAsset } from '../shared/assets.js';
import type { AssetManifest } from '../shared/assets.js';
import { buildManifest, fetchPng, summarize, validatePng, type Catalogs } from '../scripts/fetch-assets.js';
import {
  assetRelativePath, buildPublicManifest, collectAssetReferences, imagePaths, preparePublicAssets, type AssetScenario,
} from '../scripts/prepare-public-assets.js';

const publishedCount = () => (JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')) as { scenarios: unknown[] }).scenarios.length;

const origin = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64',
);
const catalogs: Catalogs = {
  heroes: {
    '1': { id: 1, name: 'npc_dota_hero_antimage', localized_name: 'Anti-Mage' },
    '2': { id: 2, name: 'npc_dota_hero_axe', localized_name: 'Axe' },
  },
  items: {
    blink: { id: 1, dname: 'Blink Dagger' },
    recipe_blink: { id: 12, dname: 'Blink Dagger Recipe', img: `${origin}items/recipe.png` },
    neutral_test: { id: 99, dname: "Seer's Stone" },
  },
  itemIds: { '1': 'blink', '12': 'recipe_blink', '99': 'neutral_test', '104': 'recipe_unknown', '105': 'unused_variant' },
};
const sources = ['https://example.test/heroes.json', 'https://example.test/items.json', 'https://example.test/item_ids.json'];
const manifest = () => buildManifest(catalogs, sources);
const imageResponse = () => new Response(png, { headers: { 'content-type': 'image/png' } });

describe('asset resolvers and complete catalog reporting', () => {
  it('resolves stable hero IDs, canonical names, internal names and normalized labels', () => {
    const assets = manifest();
    for (const value of ['1', 'npc_dota_hero_antimage', 'antimage', 'Anti-Mage', 'ANTI MAGE']) {
      expect(resolveHeroAsset(assets, value)?.name).toBe('npc_dota_hero_antimage');
    }
    expect(resolveHeroAsset(assets, 'player-123', 'Anti Mage')?.id).toBe(1);
    expect(resolveHeroAsset(null, '1')).toBeNull();
    expect(resolveHeroAsset(assets, 'unknown')).toBeNull();
    expect(resolveHeroAsset(assets, 'constructor')).toBeNull();
    expect(resolveHeroAsset(assets, '__proto__')).toBeNull();
    expect(resolveHeroAsset(assets, '')).toBeNull();
  });

  it('resolves item classnames, actual IDs, labels and explicit aliases without collapsing variants', () => {
    const assets = manifest();
    for (const name of ['item_blink', 'blink', 'BLINK DAGGER', 'blink-dagger', '1']) {
      expect(resolveItemAsset(assets, name)?.name).toBe('item_blink');
    }
    expect(resolveItemAsset(assets, 'seers stone')?.id).toBe(99);
    assets.items.item_blink.aliases.push('documented_old_name');
    expect(resolveItemAsset(assets, 'documented_old_name')?.id).toBe(1);
    expect(resolveItemAsset(assets, 'recipe_blink')?.id).toBe(12);
    expect(resolveItemAsset(assets, 'item_recipe_unknown')?.id).toBe(104);
    expect(resolveItemAsset(assets, 'recipe')).toBeNull();
    expect(resolveItemAsset(assets, 'blink_2')).toBeNull();
    expect(resolveItemAsset(null, 'blink')).toBeNull();
  });

  it('refuses ambiguous labels while retaining exact internal-name matches', () => {
    const assets = manifest();
    assets.items.item_unused_variant.label = 'Blink Dagger';
    expect(resolveItemAsset(assets, 'Blink Dagger')).toBeNull();
    expect(resolveItemAsset(assets, 'item_blink')?.id).toBe(1);
  });

  it('preserves every ID-only variant and records metadata-proven shared images', () => {
    const assets = manifest();
    expect(Object.keys(assets.items)).toHaveLength(5);
    expect(assets.items.item_recipe_blink.imageAlias).toEqual({
      name: 'item_recipe', reason: 'metadata-image', source: sources[1],
    });
    expect(assets.items.item_recipe_unknown.imageAlias).toBeUndefined();
    expect(assets.items.item_recipe_unknown.url).toBe(`${origin}items/recipe_unknown.png`);
    expect(assets.items.item_unused_variant).toMatchObject({ id: 105, status: 'missing', path: null });
    expect(assets.summary.items).toEqual({ total: 5, downloaded: 0, missing: 5 });
    expect(assets.summary.heroIcons).toEqual({ total: 2, downloaded: 0, missing: 2 });
    expect(assets.missing).toHaveLength(9);
  });

  it('reports download failures explicitly, never as successful placeholder images', () => {
    const assets = manifest();
    Object.assign(assets.items.item_blink, { status: 'downloaded', path: '/assets/items/blink.png' });
    assets.items.item_unused_variant.error = 'HTTP 404';
    summarize(assets);
    expect(assets.summary.items).toEqual({ total: 5, downloaded: 1, missing: 4 });
    expect(assets.missing).toContainEqual({
      kind: 'item', name: 'item_unused_variant', url: `${origin}items/unused_variant.png`, error: 'HTTP 404',
    });
    expect(resolveItemAsset(assets, 'unused_variant')).toMatchObject({ path: null, status: 'missing' });
  });

  it('rejects conflicting definition IDs and unapproved metadata images', () => {
    expect(() => buildManifest({ ...catalogs, itemIds: { ...catalogs.itemIds, '999': 'blink' } }, sources)).toThrow('Conflicting');
    expect(() => buildManifest({
      ...catalogs, items: { evil: { id: 123, img: 'https://example.test/evil.png' } },
    }, sources)).toThrow('Unapproved image URL');
  });

  it('preserves active, passive and innate abilities, with real IDs and explicit unsupported talents', () => {
    const assets = buildManifest({
      ...catalogs,
      heroAbilities: { npc_dota_hero_mirana: {
        abilities: ['mirana_arrow', 'mirana_innate', 'generic_hidden'],
        talents: [{ name: 'special_bonus_unique_mirana' }],
      } },
      abilities: {
        mirana_arrow: { dname: 'Sacred Arrow', img: `${origin}abilities/mirana_arrow.png` },
        mirana_innate: { dname: 'Innate Test' },
        special_bonus_unique_mirana: { dname: '+1 Arrows' },
        AbilityCastPoint: { img: `${origin}abilities/AbilityCastPoint.png` },
      },
      abilityIds: { '5070': 'mirana_arrow', '8000': 'mirana_innate', '8001,8002': 'legacy_variant' },
    }, sources);
    for (const name of ['mirana_arrow', 'Sacred Arrow', 'sacred-arrow', '5070']) {
      expect(resolveAbilityAsset(assets, name)).toMatchObject({ name: 'mirana_arrow', id: 5070 });
    }
    expect(resolveAbilityAsset(assets, 'mirana_innate')).toMatchObject({ id: 8000 });
    expect(resolveAbilityAsset(assets, 'generic_hidden')).toMatchObject({ id: null, status: 'missing' });
    expect(resolveAbilityAsset(assets, 'legacy_variant')).toMatchObject({ id: null, aliases: expect.arrayContaining(['8001', '8002']) });
    expect(resolveAbilityAsset(assets, '8002')?.name).toBe('legacy_variant');
    expect(resolveAbilityAsset(assets, 'special_bonus_unique_mirana')).toBeNull();
    expect(resolveAbilityAsset(assets, 'unrelated_arrow')).toBeNull();
    expect(resolveAbilityAsset(null, 'mirana_arrow')).toBeNull();
    expect(assets.summary.abilities).toEqual({ total: 4, downloaded: 0, missing: 4 });
    expect(assets.summary.unsupportedAbilities).toBe(2);
    expect(assets.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ability', name: 'special_bonus_unique_mirana' }),
      expect.objectContaining({ kind: 'ability', name: 'AbilityCastPoint' }),
    ]));
    expect(assets.missing).toContainEqual({
      kind: 'ability', name: 'mirana_arrow', url: `${origin}abilities/mirana_arrow.png`, error: 'Not downloaded',
    });
  });

  it('accepts older manifests without abilities without guessing hero or item artwork', () => {
    const assets = manifest();
    Reflect.deleteProperty(assets, 'abilities');
    expect(resolveAbilityAsset(assets, 'mirana_arrow')).toBeNull();
  });
});

describe('bounded, verified downloads', () => {
  it('accepts PNG data and rejects HTML, damaged magic and truncated PNGs', async () => {
    expect(() => validatePng(png)).not.toThrow();
    expect(() => validatePng(Buffer.from('<html>not an icon</html>'))).toThrow('Invalid');
    expect(() => validatePng(png.subarray(0, png.length - 8))).toThrow('truncated');
    const fetcher = vi.fn(async () => imageResponse());
    expect(await fetchPng(`${origin}items/blink.png`, fetcher)).toEqual(png);
    expect(fetcher.mock.calls).toHaveLength(1);
    await expect(fetchPng(`${origin}items/blink.png`, async () =>
      new Response(png, { headers: { 'content-type': 'text/html' } }))).rejects.toThrow('Expected image/png');
    await expect(fetchPng(`${origin}items/blink.png`, async () =>
      new Response('<html>not a PNG</html>', { headers: { 'content-type': 'image/png' } }))).rejects.toThrow('Invalid');
  });

  describe('app-specific public asset preparation', () => {
    const corpus = { catalogSha256: 'a'.repeat(64), scenarios: [] };
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const temporaryRoots: string[] = [];
    afterEach(async () => {
      vi.restoreAllMocks();
      for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    it('collects every playback frame, setup, option and event, preserving aliases and missing/unknown states', () => {
      const source = manifest();
      const hero = { id: '1', name: 'Anti Mage', items: [{ name: 'blink', charges: null, cooldown: null }], abilities: [] };
      const scenario: AssetScenario = {
        startSnapshot: { heroes: [hero] },
        frames: [
          { heroes: [hero] },
          { heroes: [{ ...hero, items: [{ name: 'recipe_unknown', charges: null, cooldown: null }] }] },
        ],
        question: { optionIds: ['1'], answerId: '1' },
        events: [{ actorId: '2', targetId: null, ability: 'recipe_blink' }],
      };
      const references = collectAssetReferences([scenario]);
      const subset = buildPublicManifest(source, references, corpus, 'b'.repeat(64));
      expect(Object.keys(subset.heroes)).toEqual(['npc_dota_hero_antimage', 'npc_dota_hero_axe']);
      expect(Object.keys(subset.items)).toEqual(['item_blink', 'item_recipe_blink', 'item_recipe_unknown']);
      expect(subset.items.item_recipe_unknown).toEqual(source.items.item_recipe_unknown);
      expect(subset.items.item_recipe_blink.imageAlias).toEqual(source.items.item_recipe_blink.imageAlias);
      expect(resolveAbilityAsset(subset, 'recipe_blink')).toBeNull();
      expect(subset.missing).toHaveLength(7);
      expect(subset.bundle.referenceOccurrences).toBeGreaterThan(subset.bundle.distinctReferences);
      expect(source.items.item_unused_variant).toBeDefined();
      expect(subset.items.item_unused_variant).toBeUndefined();
    });

    it('refuses pruning that would turn an ambiguous unknown label into a false match', () => {
      const source = manifest();
      source.items.item_unused_variant.label = 'Blink Dagger';
      expect(() => buildPublicManifest(source, [
        { kind: 'item', id: 'item_blink', occurrences: 1 },
        { kind: 'item', id: 'Blink Dagger', occurrences: 1 },
      ], corpus, 'b'.repeat(64))).toThrow('Pruning would change');
    });

    it('retains only referenced unsupported entries, and shares PNGs without inventing extra catalog entries', () => {
      const source = manifest();
      source.unsupported = [
        { kind: 'ability', name: 'special_bonus_kept', reason: 'No distinct icon' },
        { kind: 'ability', name: 'special_bonus_unused', reason: 'No distinct icon' },
      ];
      const recipe = source.items.item_recipe_blink;
      Object.assign(recipe, { path: '/assets/items/recipe.png', status: 'downloaded', bytes: png.length, sha256: digest(png) });
      source.items.item_recipe_other = { ...recipe, name: 'item_recipe_other', id: 500, label: 'Other Recipe', aliases: ['recipe_other'] };
      const subset = buildPublicManifest(source, [
        { kind: 'item', id: 'recipe_blink', occurrences: 1 },
        { kind: 'item', id: 'recipe_other', occurrences: 1 },
        { kind: 'ability', id: 'special_bonus_kept', occurrences: 1 },
      ], corpus, 'b'.repeat(64));
      expect(imagePaths(subset).size).toBe(1);
      expect(Object.keys(subset.items)).toHaveLength(2);
      expect(subset.items.item_recipe).toBeUndefined();
      expect(subset.unsupported).toEqual([source.unsupported[0]]);
      expect(subset.summary.unsupportedAbilities).toBe(1);
    });

    it('rejects traversal, URL encodings, external URLs and out-of-scope public paths', () => {
      for (const path of [
        '/assets/../outside.png', '/assets/items/../../outside.png', '/assets/items/%2e%2e/x.png',
        '/assets/items\\outside.png', '/assets/catalog/heroes.json', '/assets/items/x.png?x=1',
        'https://example.test/x.png', '/maps/x.png', '/assets/items//x.png',
      ]) expect(() => assetRelativePath(path)).toThrow('outside allowed');
      expect(assetRelativePath('/assets/heroes/icons/antimage.png')).toBe('heroes/icons/antimage.png');
    });

    async function fixture() {
      await mkdir('.cache', { recursive: true });
      const root = await mkdtemp(resolve('.cache/asset-preparation-test-'));
      temporaryRoots.push(root);
      const index = JSON.parse(await readFile('public/scenarios/index.json', 'utf8'));
      const entry = index.scenarios[0];
      const clip = await readFile(`public${entry.path}`);
      const scenario = JSON.parse(clip.toString('utf8'));
      const realManifest: AssetManifest = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
      const retained = structuredClone(resolveHeroAsset(realManifest, scenario.frames[0].heroes[0].id)!);
      Object.assign(retained, { sha256: digest(png), bytes: png.length });
      if (retained.icon) Object.assign(retained.icon, { sha256: digest(png), bytes: png.length });
      const source = manifest();
      source.heroes = { [retained.name]: retained };
      source.items = {};
      source.abilities = {};
      summarize(source);
      const assets = resolve(root, 'public/assets');
      await mkdir(resolve(root, 'public/scenarios'), { recursive: true });
      await writeFile(resolve(root, 'public/scenarios/index.json'), JSON.stringify({ version: 1, scenarios: [entry], daily: {} }));
      await writeFile(resolve(root, `public${entry.path}`), clip);
      for (const path of imagePaths(source).keys()) {
        await mkdir(resolve(assets, path, '..'), { recursive: true });
        await writeFile(resolve(assets, path), png);
      }
      await mkdir(resolve(assets, 'catalog'), { recursive: true });
      await writeFile(resolve(assets, 'catalog/unused.json'), '{"privateFullCatalog":true}');
      await writeFile(resolve(assets, 'manifest.json'), `${JSON.stringify(source, null, 2)}\n`);
      return { root, assets, source };
    }

    it('backs up the entire original tree, preserves byte hashes, removes unused metadata and is reproducible offline', async () => {
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited during preparation'));
      const { root, assets } = await fixture();
      const report = await preparePublicAssets({ root });
      expect(report.pngFiles).toBe(2);
      expect(report.checks).toEqual({ identicalResolutions: true, identicalPngHashes: true, noUnreferencedFiles: true });
      expect(await readFile(resolve(root, report.backup!, 'catalog/unused.json'), 'utf8')).toContain('privateFullCatalog');
      expect(await readdir(resolve(assets, 'catalog'))).toEqual([]);
      const firstManifest = await readFile(resolve(assets, 'manifest.json'));
      await preparePublicAssets({ root, check: true, source: report.backup! });
      await preparePublicAssets({ root });
      expect(await readFile(resolve(assets, 'manifest.json'))).toEqual(firstManifest);
      const output: AssetManifest = JSON.parse(firstManifest.toString('utf8'));
      for (const [path, image] of imagePaths(output)) expect(digest(await readFile(resolve(assets, path)))).toBe(image.sha256);
      expect(network).not.toHaveBeenCalled();
    });

    it('fails closed on checksum corruption, symlinks and out-of-root source directories before pruning', async () => {
      const { root, assets, source } = await fixture();
      const path = [...imagePaths(source).keys()][0];
      await writeFile(resolve(assets, path), 'corrupted');
      await expect(preparePublicAssets({ root })).rejects.toThrow('Invalid');
      expect(await readFile(resolve(assets, 'catalog/unused.json'), 'utf8')).toContain('privateFullCatalog');
      await writeFile(resolve(assets, path), png);
      await symlink(resolve(root, 'public/scenarios'), resolve(assets, 'linked'));
      await expect(preparePublicAssets({ root })).rejects.toThrow('Symlink refused');
      await expect(preparePublicAssets({ root, source: '..' })).rejects.toThrow('Source must');
    });

    it('verifies a clean checkout using only published assets and scenarios, with no private cache or network', async () => {
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited during verification'));
      await mkdir('.cache', { recursive: true });
      const root = await mkdtemp(resolve('.cache/asset-preparation-clean-checkout-'));
      temporaryRoots.push(root);
      await cp('public/assets', resolve(root, 'public/assets'), { recursive: true });
      await cp('public/scenarios', resolve(root, 'public/scenarios'), { recursive: true });
      await expect(lstat(resolve(root, '.cache'))).rejects.toMatchObject({ code: 'ENOENT' });
      const report = await preparePublicAssets({ root, check: true });
      expect(report).toMatchObject({
        scenarioCount: publishedCount(), backup: null,
        checks: { identicalResolutions: true, identicalPngHashes: true, noUnreferencedFiles: true },
      });
      await expect(lstat(resolve(root, '.cache/asset-backups'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(resolve(root, '.cache/asset-catalog'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(network).not.toHaveBeenCalled();
    });

    it('ships exactly the referenced subset, with every hero and item portrait present', async () => {
      const report = await preparePublicAssets({ check: true });
      expect(report.scenarioCount).toBe(publishedCount());
      expect(report.summary.heroes.missing).toBe(0);
      expect(report.summary.heroIcons.missing).toBe(0);
      expect(report.summary.items.missing).toBe(0);
    });
  });

  it('does not retry permanent missing icons or follow redirects', async () => {
    const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
      expect(options?.redirect).toBe('error');
      return new Response('', { status: 404 });
    });
    await expect(fetchPng(`${origin}items/missing.png`, fetcher)).rejects.toThrow('HTTP 404');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(fetchPng('https://example.test/icon.png', fetcher)).rejects.toThrow('Unapproved');
  });

  it('bounds retry attempts for transient failures', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    await expect(fetchPng(`${origin}items/blink.png`, fetcher, { retries: 1 })).rejects.toThrow('HTTP 503');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds declared and streamed response sizes', async () => {
    await expect(fetchPng(`${origin}items/blink.png`, async () =>
      new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '9999' } }),
    { maxBytes: 32 })).rejects.toThrow('byte limit');
    await expect(fetchPng(`${origin}items/blink.png`, async () => imageResponse(), { maxBytes: 32 })).rejects.toThrow('byte limit');
  });

  it('aborts requests at the configured deadline', async () => {
    const fetcher: typeof fetch = async (_url, options) => new Promise((_done, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    });
    await expect(fetchPng(`${origin}items/blink.png`, fetcher, { timeoutMs: 10, retries: 0 })).rejects.toThrow('Timed out');
  });
});
