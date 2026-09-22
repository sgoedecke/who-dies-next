import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { catalogSchema, scenarioSchema } from '../shared/scenario';
import type { Scenario } from '../shared/scenario';
import { clientMapEligibility, clientMapSchema } from '../shared/client-map';
import { frameAt, worldToScreen } from '../src/game';
import { minimapCrop } from '../src/ClientMap';
import { readabilityViewports } from './ui-viewports';
import { createTestScenario } from './fixtures/scenario';

async function controlledClip(count = 4): Promise<Scenario> {
  const clip = createTestScenario();
  clip.id = 'camera-fixture';
  clip.bounds = { minX: -950, maxX: 950, minY: -950, maxY: 950 };
  const endpoints = [[-700, -600], [700, -600], [-600, 700], [600, 700], [0, 0]];
  for (const frame of clip.frames) {
    const existing = frame.heroes;
    frame.heroes = Array.from({ length: count }, (_, index) => {
      const original = existing[index] ?? existing.at(-1)!;
      return {
        ...original,
        id: index < existing.length ? original.id : `extra-${index}`,
        name: index < existing.length ? original.name : `Hero ${index + 1}`,
        alive: index < existing.length ? original.alive : true,
        x: endpoints[index][0] * frame.time / clip.duration,
        y: endpoints[index][1] * frame.time / clip.duration,
      };
    });
  }
  clip.startSnapshot = structuredClone(clip.frames[0]);
  clip.question.optionIds = clip.startSnapshot.heroes.map(hero => hero.id);
  return clip;
}

async function routeClip(page: Page, clip: Scenario, payload: unknown = clip) {
  await page.route('**/scenarios/index.json', route => route.fulfill({ json: {
    version: 1, daily: {}, scenarios: [{
      id: clip.id, title: clip.title, kind: clip.source.kind, path: `/scenarios/${clip.id}.json`,
      matchStartTime: clip.source.kind === 'replay' ? clip.source.matchStartTime : undefined,
    }],
  } }));
  await page.route(`**/scenarios/${clip.id}.json`, route => route.fulfill({ json: payload }));
  await page.goto(`./?scenario=${clip.id}`);
}

async function assertProjectedFrame(page: Page, clip: Scenario, time: number) {
  const viewport = JSON.parse((await page.locator('.arena').getAttribute('data-camera-viewport'))!);
  const viewBox = (await page.locator('.arena-actors').getAttribute('viewBox'))!.split(' ').map(Number);
  const frame = frameAt(clip, time);
  for (const hero of frame.heroes) {
    const expected = worldToScreen(clip.bounds, hero.x, hero.y, viewport)!;
    const marker = page.locator(`.map-hero[data-hero-id="${hero.id}"]`);
    const position = (await marker.getAttribute('transform'))!.match(/translate\(([^,]+),([^)]+)\)/)!;
    expect(Number(position[1])).toBeCloseTo(expected.x, 5);
    expect(Number(position[2])).toBeCloseTo(expected.y, 5);
    const radius = Number(await marker.locator('.marker-halo').getAttribute('r'));
    expect(expected.x - radius).toBeGreaterThanOrEqual(0);
    expect(expected.y - radius).toBeGreaterThanOrEqual(0);
    expect(expected.x + radius).toBeLessThanOrEqual(viewBox[2]);
    expect(expected.y + radius).toBeLessThanOrEqual(viewBox[3]);
    await expect(page.locator(`.map-callout[data-hero-id="${hero.id}"] .map-resource.hp .map-resource-number`))
      .toHaveText(hero.hp === null ? '?' : String(Math.round(hero.hp)));
  }
  expect(viewport.width / (clip.bounds.maxX - clip.bounds.minX))
    .toBeCloseTo(viewport.height / (clip.bounds.maxY - clip.bounds.minY), 10);
}

for (const { width, arenaWidth } of readabilityViewports) {
  test(`controlled four-hero camera remains truthful and readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const clip = await controlledClip();
    for (const frame of [clip.startSnapshot, ...clip.frames]) {
      frame.towers = [{
        id: 'boundary-tower', name: 'Boundary tower', team: 'radiant',
        x: clip.bounds.minX, y: clip.bounds.minY, z: null, hp: 1234, maxHp: 1800, alive: true,
      }];
    }
    await routeClip(page, clip);
    await expect(page.locator('.map-hero')).toHaveCount(4);
    await expect(page.locator('.map-callout')).toHaveCount(4);
    expect(Number((await page.locator('.arena-actors').getAttribute('viewBox'))!.split(' ')[2])).toBe(arenaWidth);
    const camera = await page.locator('.arena').getAttribute('data-camera-viewport');
    const bounds = await page.locator('.arena').getAttribute('data-camera-bounds');
    const tower = page.locator('.map-tower[data-map-entity="boundary-tower"]');
    await expect(tower).toBeVisible();
    expect(await tower.evaluate(node => {
      const label = node.querySelector('.tower-label')!.getBoundingClientRect();
      const arena = node.closest('.arena')!.getBoundingClientRect();
      return label.bottom <= arena.bottom && label.left >= arena.left
        && !node.closest('[clip-path]');
    })).toBe(true);
    const labels = await page.locator('.map-callout .callout-panel').all();
    const boxes = await Promise.all(labels.map(label => label.boundingBox()));
    for (const [index, box] of boxes.entries()) {
      expect(box).not.toBeNull();
      for (const other of boxes.slice(index + 1)) {
        expect(box!.x < other!.x + other!.width && box!.x + box!.width > other!.x
          && box!.y < other!.y + other!.height && box!.y + box!.height > other!.y).toBe(false);
      }
    }
    for (const hero of clip.startSnapshot.heroes) {
      const label = page.locator(`.map-callout[data-hero-id="${hero.id}"]`);
      await label.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.map-hero[aria-pressed=true]')).toHaveAttribute('data-hero-id', hero.id);
      await expect(page.locator('.hud-identity h3')).toHaveText(hero.name);
    }
    const glyph = (await page.locator('.marker-disc').first().boundingBox())!;
    expect(glyph.width).toBeGreaterThanOrEqual(35);
    expect(await page.locator('.map-callout-name').first().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12);
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Guess', exact: true }).click();
    await page.getByLabel('Pause continuation').click();
    for (const time of [0, 2.5, 5, 7.5, 10]) {
      await page.getByLabel('Continuation timeline').fill(String(time));
      await assertProjectedFrame(page, clip, time);
      await expect(page.locator('.arena')).toHaveAttribute('data-camera-viewport', camera!);
      await expect(page.locator('.arena')).toHaveAttribute('data-camera-bounds', bounds!);
    }
    await page.getByLabel('Restart continuation').click();
    await assertProjectedFrame(page, clip, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('rejects fetched five-hero replay data without truncating its heroes or answers', async ({ page }) => {
  const clip = await controlledClip(5);
  expect(clip.startSnapshot.heroes).toHaveLength(5);
  expect(clip.question.optionIds).toHaveLength(5);
  await routeClip(page, clip);
  await expect(page.getByRole('alert')).toContainText('at most four');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('.map-hero')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Guess', exact: true })).toHaveCount(0);
});

test('rejects legacy synthetic fetched data even when its catalog claims a real replay', async ({ page }) => {
  const clip = await controlledClip();
  await routeClip(page, clip, { ...clip, source: { kind: 'synthetic', label: 'Removed demo', matchId: null, patch: null } });
  await expect(page.getByRole('alert')).toContainText('replay');
  await expect(page.getByRole('radio')).toHaveCount(0);
});

test('rejects a fifth distinct hero introduced later even when each frame contains only four', async ({ page }) => {
  const clip = await controlledClip();
  clip.frames.at(-1)!.heroes[3].id = 'late-fifth';
  expect(new Set(clip.frames.flatMap(frame => frame.heroes.map(hero => hero.id))).size).toBe(5);
  await routeClip(page, clip);
  await expect(page.getByRole('alert')).toContainText('participant set');
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.locator('.map-hero')).toHaveCount(0);
});

test('published camera contains every trajectory and shares its exact crop with the minimap and towers', async ({ page }) => {
  test.setTimeout(60_000);
  const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
  const map = clientMapSchema.parse(JSON.parse(await readFile('public/maps/dota-6934.json', 'utf8')));
  const scenes = await Promise.all(catalog.scenarios.filter(entry => entry.kind === 'replay').map(async entry =>
    scenarioSchema.parse(JSON.parse(await readFile(`public${entry.path}`, 'utf8')))));
  const clip = scenes.find(scene => clientMapEligibility(map, scene).eligible);
  test.skip(!clip, 'No map-checked playable replay has been published yet');
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.goto(`./?scenario=${clip!.id}`);
  await expect(page.locator('.client-minimap')).toBeVisible();
  const camera = await page.locator('.arena').getAttribute('data-camera-viewport');
  const viewport = JSON.parse(camera!);
  const crop = minimapCrop(map, clip!.bounds);
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    expect(Number(await page.locator('.minimap-crop').getAttribute(field))).toBeCloseTo(crop[field], 8);
  }
  const minimap = (await page.locator('.client-minimap').boundingBox())!;
  for (const tower of clip!.startSnapshot.towers ?? []) {
    const expected = worldToScreen(clip!.bounds, tower.x, tower.y, viewport);
    if (!expected) continue;
    await expect(page.locator(`.map-tower[data-map-entity="${tower.id}"]`)).toHaveAttribute('transform', `translate(${expected.x},${expected.y})`);
  }
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Pause continuation').click();
  for (let time = 0; time <= clip!.duration; time += 0.25) {
    await page.getByLabel('Continuation timeline').fill(String(time));
    await assertProjectedFrame(page, clip!, time);
    await expect(page.locator('.arena')).toHaveAttribute('data-camera-viewport', camera!);
    for (const marker of await page.locator('.marker-halo').all()) {
      const box = (await marker.boundingBox())!;
      expect(box.y + box.height).toBeLessThan(minimap.y);
    }
  }
  await page.getByLabel('Restart continuation').click();
  await assertProjectedFrame(page, clip!, 0);
});

test('320px late-frame callouts stay separate from each other, every hero and the minimap', async ({ page }) => {
  test.setTimeout(60_000);
  const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
  const scenes = await Promise.all(catalog.scenarios.filter(entry => entry.kind === 'replay').map(async entry =>
    scenarioSchema.parse(JSON.parse(await readFile(`public${entry.path}`, 'utf8')))));
  const preferred = ['replay-9009444124-350000', 'replay-9009444124-679500', 'replay-9009344330-231267'];
  const selected = [...scenes.filter(scene => preferred.includes(scene.id)), ...scenes.filter(scene => !preferred.includes(scene.id) && scene.startSnapshot.heroes.length === 4)].slice(0, 3);
  expect(selected).toHaveLength(3);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const clip of selected) {
    await page.goto(`./?scenario=${clip.id}`);
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Guess', exact: true }).click();
    await page.getByLabel('Pause continuation').click();
    for (const time of [7.75, 8.5, 9.75, 10]) {
      await page.getByLabel('Continuation timeline').fill(String(time));
      for (const hero of clip.startSnapshot.heroes) {
        await page.locator(`.map-callout[data-hero-id="${hero.id}"]`).focus();
        await page.keyboard.press('Enter');
        const collision = await page.evaluate(() => {
          const labels = [...document.querySelectorAll('.callout-panel')].map(node => node.getBoundingClientRect());
          const protectedAreas = [...document.querySelectorAll('.marker-halo, .client-minimap')].map(node => node.getBoundingClientRect());
          const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
          return labels.some((label, index) => labels.slice(index + 1).some(other => overlaps(label, other))
            || protectedAreas.some(other => overlaps(label, other)));
        });
        expect(collision, `${clip.id} t=${time}, inspected=${hero.id}`).toBe(false);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator(`.map-callout[data-hero-id="${hero.id}"]`).evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
      }
    }
  }
});

test('all published hero names fit their callouts at a readable phone font size', async ({ page }) => {
  test.setTimeout(60_000);
  const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
  const names = new Map<string, string>();
  for (const entry of catalog.scenarios.filter(entry => entry.kind === 'replay')) {
    const clip = scenarioSchema.parse(JSON.parse(await readFile(`public${entry.path}`, 'utf8')));
    for (const hero of clip.startSnapshot.heroes) names.set(hero.name, clip.id);
  }
  expect(names.size).toBeGreaterThan(0);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const id of new Set(names.values())) {
    await page.goto(`./?scenario=${id}`);
    await expect(page.locator('.map-callout').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const labels = await page.locator('.map-callout').evaluateAll(nodes => nodes.map(node => {
      const text = node.querySelector<SVGTextElement>('.map-callout-name')!;
      const box = text.getBBox();
      return {
        name: text.textContent,
        right: box.x + box.width,
        panel: Number(node.querySelector('.callout-panel')!.getAttribute('width')),
        font: Number.parseFloat(getComputedStyle(text).fontSize),
      };
    }));
    for (const label of labels) {
      expect(label.font, label.name!).toBeGreaterThanOrEqual(12);
      expect(label.right, label.name!).toBeLessThanOrEqual(label.panel - 4);
    }
  }
});
