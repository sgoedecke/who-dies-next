import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { catalogSchema, scenarioSchema } from '../shared/scenario.js';
import { clientMapEligibility, clientMapSchema } from '../shared/client-map.js';
import { resolveHeroAsset, type AssetManifest } from '../shared/assets.js';
import { eligiblePracticeEntries } from '../src/availability';
import { frameAt, readableName, scenarioPath } from '../src/game';
import { trajectoryBounds } from '../shared/encounter';
import { createTestScenario } from './fixtures/scenario';

const publishedCatalog = catalogSchema.parse(JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')));
const publishedReplays = eligiblePracticeEntries(publishedCatalog).map(entry =>
  scenarioSchema.parse(JSON.parse(readFileSync(`public${scenarioPath(publishedCatalog, entry.id)}`, 'utf8'))));
const primaryReplay = publishedReplays[0];
if (!primaryReplay) throw new Error('Browser replay tests require a published eligible replay');
const publishedMap = clientMapSchema.parse(JSON.parse(readFileSync('public/maps/dota-6934.json', 'utf8')));
const referenceReplay = publishedReplays.find(scene => clientMapEligibility(publishedMap, scene).eligible);
if (!referenceReplay) throw new Error('Map browser tests require a map-checked playable replay');

function fixtureCatalog() {
  const scene = createTestScenario();
  return {
    ...publishedCatalog,
    scenarios: [...publishedCatalog.scenarios, {
      id: scene.id, title: 'TEST ONLY', kind: scene.source.kind,
      path: `/scenarios/${scene.id}.json`, matchStartTime: scene.source.matchStartTime,
    }],
  };
}

async function mockUnitScenario(page: Page) {
  await page.route('**/scenarios/unit-fight.json', route => route.fulfill({ json: createTestScenario() }));
  await page.route('**/scenarios/index.json', route => new URL(page.url()).searchParams.get('scenario') === 'unit-fight'
    ? route.fulfill({ json: fixtureCatalog() }) : route.continue());
}

test.beforeEach(async ({ page }) => { await mockUnitScenario(page); });

async function mapFixture(page: Page) {
  const sample = createTestScenario();
  const scene = structuredClone(sample);
  scene.id = 'unit-map-regression';
  const x = (scene.bounds.minX + scene.bounds.maxX) / 2;
  const y = (scene.bounds.minY + scene.bounds.maxY) / 2;
  const times = [...new Set([...sample.frames.map(frame => frame.time), 4, 6, 8])].sort((a, b) => a - b);
  scene.frames = times.map(time => ({
    ...structuredClone(frameAt(sample, time)), time,
    towers: [{ id: 'unit-tower', name: 'Test Tower', team: 'radiant', x, y, z: null, hp: time < 8 ? 1431 : 0, maxHp: 1800, alive: time < 8 }],
    trees: time < 4 ? [] : [{ id: 'unit-tree', x: x + 100, y: y + 100, z: null, alive: time < 6 }],
  }));
  scene.startSnapshot = structuredClone(scene.frames[0]);
  scenarioSchema.parse(scene);
  await page.route('**/scenarios/index.json', route => route.fulfill({ json: {
    version: 1, daily: {}, scenarios: [{ id: scene.id, title: 'TEST ONLY map regression', kind: 'replay', path: `/scenarios/${scene.id}.json`, matchStartTime: scene.source.matchStartTime }],
  } }));
  await page.route(`**/scenarios/${scene.id}.json`, route => route.fulfill({ json: scene }));
  await page.goto(`./?scenario=${scene.id}`);
}

test('each visit stays frozen, locks once and starts fresh after reloading', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('./?scenario=unit-fight');
  await expect(page.getByRole('heading', { level: 1, name: 'Who dies next?', exact: true })).toBeVisible();
  await expect(page.locator('.question-row')).toHaveText('Who dies next?');
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.getByLabel('Continuation timeline')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Event feed' })).toHaveCount(0);
  await page.getByRole('radio', { name: /Windranger/ }).check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await expect(page.getByLabel('Pause continuation')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await page.getByLabel('Continuation timeline').fill('10');
  await expect(page.getByRole('region', { name: 'Event feed' }).getByTitle('Windranger dies first. Lina survives the window.', { exact: true })).toBeVisible();
  await page.getByLabel('Restart continuation').click();
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
  await page.getByLabel('Play continuation').click();
  await expect(page.getByLabel('Pause continuation')).toBeVisible();
  await page.waitForTimeout(350);
  await page.getByLabel('Pause continuation').click();
  expect(Number(await page.getByLabel('Continuation timeline').inputValue())).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.locator('.result, input[type=radio]:checked')).toHaveCount(0);
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
  expect(errors).toEqual([]);
});

test('mobile layout remains within viewport and unknown state is explicit', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./?scenario=unit-fight');
  await page.getByRole('button', { name: /^Axe\b/ }).click();
  await page.getByRole('button', { name: /Inspect Counter Helix/ }).click();
  await expect(page.getByText('Counter Helix', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Level 4 · Cooldown unknown', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Selected slot details' })).toContainText('Lv 4 · ?s');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('wrong predictions stay locked and do not reveal future events before scrubbing', async ({ page }) => {
  await page.goto('./?scenario=unit-fight');
  await page.getByRole('radio', { name: /Lina/ }).check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  const verdict = page.getByRole('status', { name: 'Incorrect. Windranger dies next.' });
  // The verdict waits for the answer's recorded death so the clip is not spoiled.
  await expect(verdict).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Axe/ })).toBeDisabled();
  await expect(page.getByTitle('Axe blinks into range.', { exact: true })).toHaveCount(0);
  await page.getByLabel('Continuation timeline').fill('2');
  await expect(page.getByRole('region', { name: 'Event feed' }).getByTitle('Axe blinks into range.', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Windranger dies first. Lina survives the window.', { exact: true })).toHaveCount(0);
  await expect(verdict).toHaveCount(0);
  await page.getByLabel('Continuation timeline').fill('10');
  await expect(verdict).toBeVisible();
  await page.getByLabel('Continuation timeline').fill('0');
  await expect(verdict).toBeVisible();
});

test('published real replay is playable with a derived answer', async ({ page }) => {
  const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
  const entry = catalog.scenarios.find(s => s.kind === 'replay');
  test.skip(!entry, 'No real replay published: ingestion availability is reported separately');
  const scenario = scenarioSchema.parse(JSON.parse(await readFile(`public${entry!.path}`, 'utf8')));
  await page.goto(`./?scenario=${scenario.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Who dies next?', exact: true })).toBeVisible();
  const answer = scenario.startSnapshot.heroes.find(h => h.id === scenario.question.answerId)!;
  await page.locator(`input[type="radio"][value="${answer.id}"]`).check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Continuation timeline').fill('10');
  const death = scenario.events.find(e => e.type === 'death' && e.targetId === answer.id)!;
  const manifest: AssetManifest = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
  const label = resolveHeroAsset(manifest, answer.id, answer.name)?.label ?? answer.name;
  await expect(page.getByRole('region', { name: 'Event feed' }).getByTitle(death.description.replaceAll(answer.id, label), { exact: true })).toBeVisible();
  await page.getByLabel('Restart continuation').click();
  await page.getByLabel('Play continuation').click();
  await expect(page.getByLabel('Pause continuation')).toBeVisible();
});

test('real replay HUD uses local loaded hero, ability and item images without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`./?scenario=${primaryReplay.id}`);
  for (const kind of ['heroes', 'abilities', 'items']) {
    const images = page.locator(`img[src*="/assets/${kind}/"]:visible`);
    await expect(images.first()).toBeAttached();
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
      const box = await image.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeLessThanOrEqual(240);
      expect(box!.height).toBeLessThanOrEqual(240);
    }
  }
  expect(await page.locator('img[src^="http"]').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('isolated tree regression steps creation/destruction only at its authored sample times', async ({ page }) => {
  await mapFixture(page);
  const tree = page.locator('g.map-tree[data-map-entity="unit-tree"]');
  await expect(page.getByRole('radio').first()).toBeVisible();
  await expect(page.locator('.client-minimap, .client-map-reference')).toHaveCount(0);
  await expect(tree).toHaveCount(0);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Continuation timeline').fill('4');
  await expect(tree).toHaveAttribute('aria-label', /alive/);
  await page.getByLabel('Continuation timeline').fill('6');
  await expect(tree).toHaveAttribute('aria-label', /destroyed/);
  await page.getByLabel('Restart continuation').click();
  await expect(tree).toHaveCount(0);
});

test('isolated tower regression preserves HP and destruction sampling without setup spoilers', async ({ page }) => {
  await mapFixture(page);
  const tower = page.locator('g.map-tower[data-map-entity="unit-tower"]');
  await expect(tower).toHaveAttribute('aria-label', /alive, HP 1431/);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Continuation timeline').fill('8');
  await expect(tower).toHaveAttribute('aria-label', /destroyed, HP 0/);
  await page.getByLabel('Restart continuation').click();
  await expect(tower).toHaveAttribute('aria-label', /alive, HP 1431/);
});

test('prediction and HUD controls support keyboard and touch input', async ({ page, browser, baseURL }) => {
  await page.goto('./?scenario=unit-fight');
  const answer = page.getByRole('radio', { name: /Windranger/ });
  await answer.focus();
  await page.keyboard.press('Space');
  await expect(answer).toBeChecked();
  await page.getByRole('button', { name: 'Guess', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Pause continuation')).toBeEnabled();

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const mobile = await touch.newPage();
    await mockUnitScenario(mobile);
    await mobile.goto(new URL('./?scenario=unit-fight', baseURL).href);
    await mobile.getByRole('radio', { name: /Windranger/ }).tap();
    await mobile.getByRole('button', { name: 'Guess', exact: true }).tap();
    await expect(mobile.getByLabel('Pause continuation')).toBeEnabled();
    await mobile.getByRole('button', { name: /^Axe\b/ }).tap();
    await mobile.getByRole('button', { name: /Inspect Counter Helix/ }).tap();
    await expect(mobile.getByText('Counter Helix', { exact: true })).toBeVisible();
  } finally { await touch.close(); }
});

for (const age of ['stale', 'unknown'] as const) {
  test(`rejects ${age} fetched replay age even if the catalog claims it is current`, async ({ page }) => {
    const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
    const entry = catalog.scenarios.find(s => s.kind === 'replay')!;
    const scenario = scenarioSchema.parse(JSON.parse(await readFile(`public${entry.path}`, 'utf8')));
    if (scenario.source.kind !== 'replay') throw new Error('Expected a real scenario fixture');
    entry.matchStartTime = Math.floor(Date.now() / 1000) - 3600;
    scenario.source.matchStartTime = age === 'stale' ? Math.floor(Date.now() / 1000) - 181 * 86400 : null;
    await page.route('**/scenarios/index.json', route => route.fulfill({ json: catalog }));
    await page.route(`**${entry.path}`, route => route.fulfill({ json: scenario }));
    await page.goto(`./?scenario=${entry.id}`);
    await expect(page.getByText(age === 'stale' ? /outside the rolling 180-day window/ : /Match age is unknown/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guess', exact: true })).toHaveCount(0);
  });
}

test('actual hero level-up follows playback and restart preserves setup level', async ({ page }) => {
  const upgrade = publishedReplays.flatMap(scene => scene.frames.filter(frame => frame.time <= scene.duration).flatMap(frame =>
    frame.heroes.flatMap(hero => {
      const initial = scene.startSnapshot.heroes.find(candidate => candidate.id === hero.id)!;
      return initial.level !== null && hero.level !== null && hero.level > initial.level
        ? [{ scene, time: frame.time, id: hero.id, from: initial.level, to: hero.level }] : [];
    })))[0];
  expect(upgrade).toBeDefined();
  await page.goto(`./?scenario=${upgrade.scene.id}`);
  await page.locator(`.map-callout[data-hero-id="${upgrade.id}"]`).click();
  const hud = page.getByRole('region', { name: 'Hero inspection' });
  await expect(hud.getByTitle(`Observed hero level ${upgrade.from}`, { exact: true })).toBeVisible();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Continuation timeline').fill(String(Math.min(upgrade.scene.duration, Math.ceil(upgrade.time * 20) / 20)));
  await page.locator(`.map-callout[data-hero-id="${upgrade.id}"]`).click();
  await expect(hud.getByTitle(`Observed hero level ${upgrade.to}`, { exact: true })).toBeVisible();
  await page.getByLabel('Restart continuation').click();
  await expect(hud.getByTitle(`Observed hero level ${upgrade.from}`, { exact: true })).toBeVisible();
});

for (const level of [0, null]) {
  test(`hero HUD distinguishes ${level === null ? 'unknown' : 'zero'} level`, async ({ page }) => {
    const sample = createTestScenario();
    sample.startSnapshot.heroes[0].level = level;
    for (const frame of sample.frames) frame.heroes[0].level = level;
    await page.route('**/scenarios/unit-fight.json', route => route.fulfill({ json: sample }));
    await page.goto('./?scenario=unit-fight');
    await expect(page.getByRole('region', { name: 'Hero inspection' }).getByTitle(`Observed hero level ${level ?? 'unknown'}`, { exact: true })).toBeVisible();
  });
}

test('minimal screen removes Info, Map, scenario dropdown and all their former content', async ({ page }) => {
  await page.goto('./?scenario=unit-fight');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Who dies next?');
  await expect(page.locator('.question-row')).toHaveText('Who dies next?');
  await expect(page.locator('.question-accent')).toHaveText('next');
  await expect(page.locator('.window-length')).toHaveCount(0);
  expect(await page.locator('.question-accent').evaluate(node => getComputedStyle(node).color)).toBe('rgb(183, 237, 124)');
  expect(await page.locator('h1').evaluate(node => getComputedStyle(node).color)).not.toBe('rgb(183, 237, 124)');
  await expect(page.locator('header, footer, .how-to, .eyebrow, .hud-hint, .empty-log')).toHaveCount(0);
  await expect(page.locator('.info-panel, .info-body, .map-control, .map-control-panel, select')).toHaveCount(0);
  await expect(page.locator('.game-toolbar, .edition-tabs, .date-label, .effects')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Daily|Practice|\?)$/ })).toHaveCount(0);
  await expect(page.getByLabel('Observed effects')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Info|Map)$/ })).toHaveCount(0);
  const content = await page.locator('body').textContent();
  for (const removed of ['dotadle.', 'A game of fight sense', 'Read the fight', 'MAKE THE CALL', 'Inspect the lineup', 'Fight log', 'Source time', 'Terrain heights unavailable', 'Select a slot', 'No spoilers', 'Independent fan project', 'Replay SHA-256', 'Authored demonstration.', 'Map layer sources']) {
    expect(content).not.toContain(removed);
  }
  await expect(page.locator('.playback-time')).toHaveText('0.0 / 10s');
});

test('legacy mode, pinned dates and saved completions do not restrict a fresh random game', async ({ page }) => {
  const catalog = fixtureCatalog();
  const day = new Date().toISOString().slice(0, 10);
  catalog.daily = { [day]: primaryReplay.id };
  const stored = { [`dotadle:v1:${day}:unit-fight`]: '{"version":1,"answerId":"npc_dota_hero_windrunner","locked":true}', unrelated: 'keep me' };
  await page.addInitScript(values => {
    Math.random = () => 0.999999;
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, stored);
  await page.route('**/scenarios/index.json', route => route.fulfill({ json: catalog }));
  await page.goto('./?mode=daily');
  await expect(page).toHaveURL(/\?scenario=unit-fight$/);
  await expect(page.getByRole('button', { name: 'Guess', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.getByRole('button', { name: /^(Daily|Practice)$/ })).toHaveCount(0);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.locator('.result, input[type=radio]:checked')).toHaveCount(0);
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual(stored);
});

test('Guess commits once and autoplays with reduced motion without persisting or restoring completion', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Object.defineProperty(window, '__guessWrites', { value: [] });
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('dotadle:')) (window as typeof window & { __guessWrites: string[] }).__guessWrites.push(value);
      return setItem.call(this, key, value);
    };
  });
  await page.goto('./?scenario=unit-fight');
  await page.getByRole('radio', { name: /Windranger/ }).check();
  await page.clock.runFor(500);
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
  await page.getByRole('button', { name: 'Guess', exact: true }).evaluate(button => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(page.getByLabel('Pause continuation')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Guess', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __guessWrites: string[] }).__guessWrites.length)).toBe(0);
  await page.clock.runFor(2300);
  expect(Number(await page.getByLabel('Continuation timeline').inputValue())).toBeGreaterThan(2);
  await expect(page.getByRole('region', { name: 'Event feed' }).getByTitle('Axe blinks into range.', { exact: true })).toBeVisible();
  await page.getByLabel('Pause continuation').click();
  const paused = await page.getByLabel('Continuation timeline').inputValue();
  await page.clock.runFor(500);
  await expect(page.getByLabel('Continuation timeline')).toHaveValue(paused);
  await page.getByLabel('Play continuation').click();
  await page.clock.runFor(12_000);
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('10');
  await expect(page.getByLabel('Play continuation')).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('status', { name: 'Correct. Windranger dies next.' })).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.getByLabel('Pause continuation')).toHaveCount(0);
});

test('every skill has a visible actual level, with zero and unknown distinct through scrub and restart', async ({ page }) => {
  const sample = createTestScenario();
  for (const frame of [sample.startSnapshot, ...sample.frames]) frame.heroes[0].abilities = [
    { name: 'windrunner_windrun', level: frame.time >= 5 ? 1 : 0, cooldown: 0 },
    { name: 'windrunner_powershot', level: null, cooldown: null },
    { name: 'windrunner_shackleshot', level: 2, cooldown: 4 },
  ];
  await page.route('**/scenarios/unit-fight.json', route => route.fulfill({ json: sample }));
  await page.goto('./?scenario=unit-fight');
  const levels = page.locator('.ability-slot .hud-slot-level');
  await expect(levels).toHaveText(['Lv 0', 'Lv ?', 'Lv 2']);
  for (const level of await levels.all()) {
    await expect(level).toBeVisible();
    expect(await level.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(11);
  }
  await expect(page.locator('.ability-slot.unlearned')).toHaveAttribute('title', /level 0, Unlearned/);
  await expect(page.locator('.ability-slot.level-unknown')).toHaveAttribute('title', /level unknown, Cooldown unknown/);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Continuation timeline').fill('10');
  await expect(levels).toHaveText(['Lv 1', 'Lv ?', 'Lv 2']);
  await page.getByLabel('Continuation timeline').fill('4');
  await expect(levels).toHaveText(['Lv 0', 'Lv ?', 'Lv 2']);
  await page.getByLabel('Restart continuation').click();
  await expect(levels).toHaveText(['Lv 0', 'Lv ?', 'Lv 2']);
});

test('matched client map keeps sampled contours, baseline canopies and a correctly oriented full-map minimap', async ({ page }) => {
  await page.goto(`./?scenario=${referenceReplay.id}`);
  await expect(page.locator('.client-height-cell').first()).toBeAttached();
  // Terrain extends past the trajectory crop to fill the arena; trees follow the terrain extent.
  const terrain = JSON.parse((await page.locator('.arena').getAttribute('data-terrain-bounds'))!) as typeof referenceReplay.bounds;
  expect(terrain.minX).toBeLessThanOrEqual(referenceReplay.bounds.minX);
  expect(terrain.maxY).toBeGreaterThanOrEqual(referenceReplay.bounds.maxY);
  const trees = publishedMap.trees.filter(tree => tree.x >= terrain.minX && tree.x <= terrain.maxX
    && tree.y >= terrain.minY && tree.y <= terrain.maxY);
  await expect(page.locator('.client-base-tree')).toHaveCount(trees.length);
  if (trees.length) {
    await expect(page.locator('.client-base-tree').first()).toHaveAttribute('aria-label', 'Base tree; current state unknown');
    await expect(page.locator('.reference-tree-canopy').first()).toBeAttached();
  }
  const towerCount = await page.locator('.map-tower').count();
  expect(towerCount).toBe((referenceReplay.startSnapshot.towers ?? []).filter(tower => tower.x !== null && tower.y !== null).length);
  await expect(page.locator('.height-contour')).toHaveCount(2);
  await expect(page.locator('.client-minimap')).toBeVisible();
  await expect(page.locator('.info-panel, .map-control, select')).toHaveCount(0);
  const map = JSON.parse(await readFile('public/maps/dota-6934.json', 'utf8'));
  const scenario = referenceReplay;
  const width = map.elevation.width * map.elevation.cellSize;
  const height = map.elevation.height * map.elevation.cellSize;
  const crop = page.locator('.minimap-crop');
  expect(Number(await crop.getAttribute('x'))).toBeCloseTo(4 + (scenario.bounds.minX - map.elevation.minX) / width * 192);
  expect(Number(await crop.getAttribute('y'))).toBeCloseTo(196 - (scenario.bounds.maxY - map.elevation.minY) / height * 192);
  expect(Number(await crop.getAttribute('width'))).toBeCloseTo((scenario.bounds.maxX - scenario.bounds.minX) / width * 192);
  expect(Number(await crop.getAttribute('height'))).toBeCloseTo((scenario.bounds.maxY - scenario.bounds.minY) / height * 192);
  const hero = scenario.startSnapshot.heroes.find(hero => hero.x !== null && hero.y !== null)!;
  const dot = page.locator('.minimap-hero').first();
  expect(Number(await dot.getAttribute('cy'))).toBeCloseTo(196 - (hero.y! - map.elevation.minY) / height * 192);
  await expect(page.locator('.map-tower')).toHaveCount(towerCount);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await page.getByLabel('Continuation timeline').fill('6.1');
  await expect(page.locator('.client-height-cell').first()).toBeAttached();
});

for (const width of [1440, 390, 320]) {
  test(`arena inset and choices stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width > 720 ? 1100 : 844 });
    await page.goto(`./?scenario=${referenceReplay.id}`);
    await expect(page.locator('.arena > .client-minimap')).toBeVisible();
    const arena = (await page.locator('.arena').boundingBox())!;
    const inset = (await page.locator('.client-minimap').boundingBox())!;
    const controls = (await page.locator('.playback').boundingBox())!;
    const choices = (await page.locator('.prediction-panel').boundingBox())!;
    expect(inset.x).toBeGreaterThan(arena.x + arena.width / 2);
    expect(inset.y).toBeGreaterThan(arena.y + arena.height / 2);
    expect(arena.x + arena.width - inset.x - inset.width).toBeGreaterThanOrEqual(8);
    expect(arena.x + arena.width - inset.x - inset.width).toBeLessThanOrEqual(13);
    expect(arena.y + arena.height - inset.y - inset.height).toBeGreaterThanOrEqual(8);
    expect(inset.y + inset.height).toBeLessThan(controls.y);
    expect(inset.width).toBeGreaterThanOrEqual(70);
    expect(inset.width).toBeLessThanOrEqual(130);
    if (width > 720) expect(choices.x + choices.width).toBeLessThan(arena.x);
    else expect(choices.y).toBeGreaterThan(arena.y + arena.height);
    await page.getByRole('radio').first().check();
    await expect(page.getByRole('button', { name: 'Guess', exact: true })).toBeEnabled();
    const guess = (await page.getByRole('button', { name: 'Guess', exact: true }).boundingBox())!;
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await expect(next).toBeEnabled();
    const nextBox = (await next.boundingBox())!;
    expect(nextBox.y - guess.y - guess.height).toBeGreaterThanOrEqual(7);
    expect(nextBox.y - guess.y - guess.height).toBeLessThanOrEqual(9);
    expect(nextBox.x).toBeCloseTo(guess.x);
    expect(nextBox.width).toBeCloseTo(guess.width);
    expect(await next.evaluate(node => node.previousElementSibling?.textContent)).toBe('Guess');
    await expect(page.locator('.game-toolbar').getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('a controlled trajectory-edge hero remains clear of the minimap and clickable', async ({ page }) => {
  const clip = structuredClone(referenceReplay);
  const paths = trajectoryBounds(clip.frames)!;
  for (const frame of [clip.startSnapshot, clip.frames[0]]) {
    frame.heroes[1].x = paths.maxX;
    frame.heroes[1].y = paths.minY;
  }
  scenarioSchema.parse(clip);
  await page.route(`**/scenarios/${clip.id}.json`, route => route.fulfill({ json: clip }));
  await page.goto(`./?scenario=${clip.id}`);
  await expect(page.locator('.client-minimap')).toBeVisible();
  const actor = page.locator(`.map-hero[data-hero-id="${clip.startSnapshot.heroes[1].id}"]`);
  await page.locator(`.map-callout[data-hero-id="${clip.startSnapshot.heroes[1].id}"]`).click();
  const centre = await actor.evaluate(node => {
    const disc = node.querySelector('.marker-disc')!.getBoundingClientRect();
    return { x: disc.x + disc.width / 2, y: disc.y + disc.height / 2 };
  });
  const inset = (await page.locator('.client-minimap').boundingBox())!;
  const glyph = (await actor.locator('.marker-halo').boundingBox())!;
  expect(glyph.x < inset.x + inset.width && glyph.x + glyph.width > inset.x
    && glyph.y < inset.y + inset.height && glyph.y + glyph.height > inset.y).toBe(false);
  expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.map-hero'), centre)).toBe(true);
  await page.mouse.click(centre.x, centre.y);
  await expect(actor).toHaveAttribute('aria-pressed', 'true');
  const manifest: AssetManifest = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
  const hero = clip.startSnapshot.heroes[1];
  await expect(page.locator('.hud-identity h3')).toHaveText(resolveHeroAsset(manifest, hero.id, hero.name)?.label ?? readableName(hero.name));
});

test('random Next resets autoplay and inspection, cancels stale fetches, and leaves legacy storage untouched', async ({ page }) => {
  const base = structuredClone(primaryReplay);
  const current = Math.floor(Date.now() / 1000) - 3600;
  const day = new Date().toISOString().slice(0, 10);
  const savedKey = `dotadle:v1:${day}:nav-a`;
  const savedValue = JSON.stringify({ version: 1, answerId: base.question.optionIds[0], locked: true });
  await page.addInitScript(({ key, value }) => {
    Math.random = () => 0;
    localStorage.setItem(key, value);
  }, { key: savedKey, value: savedValue });
  const entries = ['nav-a', 'nav-b', 'nav-c'].map(id => ({ id, title: id, kind: 'replay', path: `/scenarios/${id}.json`, matchStartTime: current }));
  await page.route('**/scenarios/index.json', route => route.fulfill({ json: { version: 1, daily: { [day]: 'nav-a' }, scenarios: [
    entries[0],
    { ...entries[0], id: 'stale', matchStartTime: current - 181 * 86400 },
    { ...entries[0], id: 'unknown', matchStartTime: null },
    ...entries.slice(1),
  ] } }));
  await page.route('**/scenarios/nav-*.json', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!.replace('.json', '');
    const clip = structuredClone(base);
    clip.id = id;
    const level = entries.findIndex(entry => entry.id === id) + 1;
    for (const frame of [clip.startSnapshot, ...clip.frames]) for (const hero of frame.heroes) hero.level = level;
    if (id === 'nav-b') {
      clip.question.optionIds.reverse();
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    await route.fulfill({ json: clip });
  });
  await page.goto('./?scenario=nav-a');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await page.getByRole('radio').last().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await expect(page.getByLabel('Pause continuation')).toBeEnabled();
  await expect.poll(async () => Number(await page.getByLabel('Continuation timeline').inputValue())).toBeGreaterThan(0);
  await page.locator(`.map-callout[data-hero-id="${base.question.optionIds[0]}"]`).click();
  await page.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\?scenario=nav-b$/);
  await expect(page.getByTitle('Observed hero level 2', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Guess', exact: true })).toBeDisabled();
  await expect(page.locator('.map-hero[aria-pressed=true]')).not.toHaveClass(/\bdead\b/);
  await expect(page.locator('.map-hero[aria-pressed=true]')).toHaveAttribute('data-hero-id', base.question.optionIds.at(-1)!);
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  await expect(page.locator('.result')).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(/\?scenario=nav-a$/);
  await expect(page.getByRole('button', { name: 'Guess', exact: true })).toBeDisabled();
  const pending = page.waitForRequest('**/scenarios/nav-b.json');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await pending;
  await page.goBack();
  await expect(page).toHaveURL(/\?scenario=nav-a$/);
  await expect(page.getByTitle('Observed hero level 1', { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByTitle('Observed hero level 1', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
  expect(await page.evaluate(key => localStorage.getItem(key), savedKey)).toBe(savedValue);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('dotadle:')))).toEqual([savedKey]);
  await page.reload();
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Guess', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await expect(page.locator('select, .practice-navigation, .practice-count')).toHaveCount(0);
});

test('random Next can reach every eligible real clip without selecting the current clip', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    Object.defineProperty(window, '__nextRandom', { value: 0, writable: true });
    Math.random = () => (window as typeof window & { __nextRandom: number }).__nextRandom;
  });
  const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
  const entries = eligiblePracticeEntries(catalog);
  test.skip(!entries.some(entry => entry.kind === 'replay'), 'No eligible real clips are currently published');
  expect(entries.every(entry => entry.kind === 'replay')).toBe(true);
  const map = clientMapSchema.parse(JSON.parse(await readFile('public/maps/dota-6934.json', 'utf8')));
  await page.goto('./');
  await expect(page.getByRole('radio').first()).toBeVisible();
  const startId = new URL(page.url()).searchParams.get('scenario');
  const startIndex = entries.findIndex(entry => entry.id === startId);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const visited = new Set<string>();
  for (let offset = 0; offset < entries.length; offset++) {
    const index = (startIndex + offset) % entries.length;
    await expect(page).toHaveURL(new RegExp(`\\?scenario=${entries[index].id}$`));
    await expect(page.getByRole('radio').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guess', exact: true })).toBeDisabled();
    await expect(page.locator('.map-hero[aria-pressed=true]')).not.toHaveClass(/\bdead\b/);
    const clip = scenarioSchema.parse(JSON.parse(await readFile(`public${entries[index].path}`, 'utf8')));
    if (clientMapEligibility(map, clip, Date.now()).eligible) {
      await expect(page.locator('.arena > .client-minimap')).toBeVisible();
    } else {
      await expect(page.locator('.client-map-reference, .client-minimap')).toHaveCount(0);
    }
    visited.add(entries[index].id);
    if (entries.length > 1) {
      const target = entries[(index + 1) % entries.length].id;
      const pool = entries.filter(entry => entry.id !== entries[index].id);
      const draw = (pool.findIndex(entry => entry.id === target) + 0.5) / pool.length;
      await page.evaluate(value => { (window as typeof window & { __nextRandom: number }).__nextRandom = value; }, draw);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`\\?scenario=${target}$`));
      expect(target).not.toBe(entries[index].id);
    } else {
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    }
  }
  expect(visited.size).toBe(entries.length);
  await expect(page).toHaveURL(new RegExp(`\\?scenario=${startId}$`));
  await expect(page.getByRole('radio').first()).toBeVisible();
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
});

for (const count of [0, 1, 4]) {
  test(`random Next handles a partial catalog of ${count} real clips`, async ({ page }) => {
    await page.addInitScript(() => { Math.random = () => 0.999; });
    const base = structuredClone(primaryReplay);
    const scenarios = Array.from({ length: count }, (_, index) => ({
      id: `partial-${index}`, title: `Clip ${index}`, kind: 'replay', path: `/scenarios/partial-${index}.json`,
      matchStartTime: Math.floor(Date.now() / 1000) - 3600,
    }));
    const currentId = 'partial-0';
    await page.route('**/scenarios/index.json', route => route.fulfill({ json: { version: 1, scenarios, daily: {} } }));
    await page.route('**/scenarios/partial-*.json', route => {
      const id = new URL(route.request().url()).pathname.split('/').pop()!.replace('.json', '');
      return route.fulfill({ json: { ...base, id } });
    });
    await page.goto(`./?scenario=${currentId}`);
    if (count === 0) {
      await expect(page.getByRole('alert')).toContainText('No eligible real replays are available.');
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
      await page.goto('./');
      await expect(page.getByRole('alert')).toContainText('No eligible real replays are available.');
      await expect(page.getByRole('button', { name: /^(Daily|Practice)$/ })).toHaveCount(0);
      return;
    }

    await expect(page.getByRole('radio').first()).toBeVisible();
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (count <= 1) {
      await expect(next).toBeDisabled();
      await expect(next).toHaveAttribute('title', 'No other eligible real scenarios are available.');
      await expect(next).toHaveAccessibleDescription('No other eligible real scenarios are available.');
    } else {
      await next.click();
      await expect(page).toHaveURL(/\?scenario=partial-3$/);
      await next.click();
      await expect(page).toHaveURL(/\?scenario=partial-2$/);
      await expect(page.getByRole('radio').first()).toBeVisible();
    }
    await expect(page.locator('select')).toHaveCount(0);
  });
}

test('published resources and practice routing stay under the configured deployment base', async ({ page, baseURL }) => {
  const base = new URL(baseURL!);
  const resources: string[] = [];
  const failures: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (!/\/(assets|maps|scenarios)\//.test(url.pathname)) return;
    resources.push(url.pathname);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || !response.ok()) {
      failures.push(`${response.status()} ${url.href}`);
    }
  });
  await page.goto('./');
  await expect(page.getByRole('radio').first()).toBeVisible();
  await expect(page.locator('.client-minimap')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  const before = new URL(page.url()).searchParams.get('scenario');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('scenario')).not.toBe(before);
  await expect(page.getByRole('radio').first()).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(base.pathname);
  await page.waitForLoadState('networkidle');
  for (const image of await page.locator('img').all()) {
    expect(await image.getAttribute('src')).toMatch(new RegExp(`^${base.pathname}assets/`));
    expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  for (const image of await page.locator('.map-hero image').all()) {
    expect(await image.getAttribute('href')).toMatch(new RegExp(`^${base.pathname}assets/`));
  }
  for (const path of ['scenarios/index.json', 'assets/manifest.json', 'maps/dota-6934.json']) {
    expect(resources).toContain(`${base.pathname}${path}`);
  }
  expect(resources.some(path => /\/scenarios\/replay-.+\.json$/.test(path))).toBe(true);
  expect(resources.some(path => /unit-fight|sample-river-crossing/.test(path))).toBe(false);
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});

test('retired demo bookmarks recover to real gameplay without requesting a hidden demo file', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', request => { if (request.url().includes('/scenarios/')) requested.push(request.url()); });
  await page.goto('./?scenario=sample-river-crossing');
  await expect(page.locator('.selection-notice[role=status]')).toHaveText('That replay is unavailable. Showing another real replay.');
  await expect(page.getByRole('radio').first()).toBeVisible();
  await expect(page).toHaveURL(/\?scenario=replay-/);
  expect(requested.some(url => url.includes('/sample-river-crossing.json'))).toBe(false);
});

test('unavailable browser storage cannot prevent guessing or a fresh reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage disabled for regression'); } });
  });
  await page.goto('./?mode=daily&scenario=unit-fight');
  await expect(page).toHaveURL(/\?scenario=unit-fight$/);
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Guess', exact: true }).click();
  await expect(page.getByLabel('Pause continuation')).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel('Play continuation')).toBeDisabled();
  await expect(page.locator('input[type=radio]:checked, .result')).toHaveCount(0);
  expect(errors).toEqual([]);
});

const originalClips = new Set([
  'replay-9009355617-298767', 'replay-9009355617-341267', 'replay-9009355617-497500',
  'replay-9009344330-231267', 'replay-9009355617-610500', 'replay-9009344330-1442767',
]);
const additionalClips = publishedReplays.filter(scene => !originalClips.has(scene.id))
  .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
const sampleCount = Math.min(6, additionalClips.length);
const newCorpusSamples = Array.from({ length: sampleCount }, (_, index) =>
  additionalClips[Math.round(index * (additionalClips.length - 1) / Math.max(1, sampleCount - 1))].id);

for (const [index, id] of newCorpusSamples.entries()) {
  test(`new corpus clip ${id} autoplays its recorded death with gated responsive minimap`, async ({ page }) => {
    const currentCatalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
    test.skip(!eligiblePracticeEntries(currentCatalog).some(entry => entry.id === id), 'This sample was retired while the corpus was being rebuilt');
    await page.clock.install();
    await page.setViewportSize({ width: index % 2 === 0 ? 1440 : 390, height: index % 2 === 0 ? 1100 : 844 });
    const clip = scenarioSchema.parse(JSON.parse(await readFile(`public/scenarios/${id}.json`, 'utf8')));
    const map = clientMapSchema.parse(JSON.parse(await readFile('public/maps/dota-6934.json', 'utf8')));
    const manifest: AssetManifest = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
    const answer = clip.startSnapshot.heroes.find(hero => hero.id === clip.question.answerId)!;
    const label = resolveHeroAsset(manifest, answer.id, answer.name)?.label ?? answer.name;
    const death = clip.events.find(event => event.type === 'death' && event.targetId === answer.id)!;
    await page.goto(`./?scenario=${id}`);
    await expect(page.getByRole('radio').first()).toBeVisible();
    if (clientMapEligibility(map, clip, Date.now()).eligible) {
      await expect(page.locator('.arena > .client-minimap')).toBeVisible();
      const arena = (await page.locator('.arena').boundingBox())!;
      const inset = (await page.locator('.client-minimap').boundingBox())!;
      const controls = (await page.locator('.playback').boundingBox())!;
      expect(inset.x).toBeGreaterThan(arena.x);
      expect(inset.x + inset.width).toBeLessThan(arena.x + arena.width);
      expect(inset.y + inset.height).toBeLessThan(controls.y);
    } else {
      await expect(page.locator('.client-map-reference, .client-minimap')).toHaveCount(0);
    }
    await page.locator(`input[type=radio][value="${answer.id}"]`).check();
    await page.getByRole('button', { name: 'Guess', exact: true }).click();
    await expect(page.getByLabel('Pause continuation')).toBeEnabled();
    await page.clock.runFor(250);
    expect(Number(await page.getByLabel('Continuation timeline').inputValue())).toBeGreaterThan(0);
    await page.clock.fastForward(Math.ceil((death.time + 0.75) * 1000));
    expect(Number(await page.getByLabel('Continuation timeline').inputValue())).toBeGreaterThan(death.time);
    await expect(page.getByRole('status', { name: `Correct. ${label} dies next.` })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Event feed' }).getByTitle(death.description.replaceAll(answer.id, label), { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`^Inspect ${label}, hero level .+, dead$`) })).toHaveCount(1);
    await page.getByLabel('Restart continuation').click();
    await expect(page.getByLabel('Continuation timeline')).toHaveValue('0');
    await expect(page.getByLabel('Play continuation')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

for (const condition of ['unchecked', 'mismatched', 'stale', 'malformed'] as const) {
  test(`does not render reference geometry for ${condition} map context`, async ({ page }) => {
    const map = JSON.parse(await readFile('public/maps/dota-6934.json', 'utf8'));
    if (condition === 'mismatched') for (const match of map.compatibility) match.replaySha256 = '0'.repeat(64);
    if (condition === 'stale') map.source.manifestTime = Math.floor(Date.now() / 1000) - 181 * 86400;
    if (condition === 'malformed') map.elevation.rows = [];
    await page.route('**/maps/dota-6934.json', route => route.fulfill({ json: map }));
    await page.goto(`./?scenario=${condition === 'unchecked' ? 'unit-fight' : referenceReplay.id}`);
    await page.getByRole('radio').first().waitFor();
    await expect(page.locator('.client-map-reference')).toHaveCount(0);
    await expect(page.locator('.client-minimap')).toHaveCount(0);
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Guess', exact: true }).click();
    await expect(page.getByLabel('Pause continuation')).toBeEnabled();
  });
}
