import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AssetManifest } from '../shared/assets';
import { catalogSchema, scenarioSchema } from '../shared/scenario';
import { displayHeroName } from './assets';
import { arenaCamera, heroCallouts } from './camera';
import type { ScreenRect } from './camera';
import { frameAt, scenarioPath, worldToScreen } from './game';
import { readabilityViewports } from '../tests/ui-viewports';

const intersects = (a: ScreenRect, b: ScreenRect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

it('keeps every published trajectory on screen and callouts clear in nearly every state', () => {
  const catalog = catalogSchema.parse(JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')));
  const manifest: AssetManifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8'));
  const failures: string[] = [];
  let inspectedStates = 0;
  let crowdedStates = 0;
  for (const entry of catalog.scenarios.filter(entry => entry.kind === 'replay')) {
    const scene = scenarioSchema.parse(JSON.parse(readFileSync(`public${scenarioPath(catalog, entry.id)}`, 'utf8')));
    const times = [...new Set([...scene.frames.map(frame => frame.time), ...scene.frames.slice(1).map((frame, index) => (frame.time + scene.frames[index].time) / 2)])];
    for (const { arenaWidth: width } of readabilityViewports) {
      const camera = arenaCamera(scene.bounds, width);
      for (const time of times) {
        const frame = frameAt(scene, time);
        const anchors = frame.heroes.map(hero => ({ id: hero.id, name: displayHeroName(manifest, hero), ...worldToScreen(scene.bounds, hero.x, hero.y, camera.viewport)! }));
        const obstacles = (frame.towers ?? []).flatMap(tower => {
          const point = worldToScreen(scene.bounds, tower.x, tower.y, camera.viewport);
          return point && point.x >= camera.viewport.left && point.x <= camera.viewport.left + camera.viewport.width
            && point.y >= camera.viewport.top && point.y <= camera.viewport.top + camera.viewport.height
            ? [{ x: point.x - 17, y: point.y - 25, width: 34, height: 55 }] : [];
        });
        for (const anchor of anchors) {
          const glyph = { x: anchor.x - camera.markerRadius - 5, y: anchor.y - camera.markerRadius - 5, width: camera.markerRadius * 2 + 10, height: camera.markerRadius * 2 + 10 };
          if (glyph.x < 0 || glyph.y < 0 || glyph.x + glyph.width > camera.width || glyph.y + glyph.height > camera.height || intersects(glyph, camera.minimap)) {
            if (failures.length < 20) failures.push(`${scene.id} ${width}px t=${time}: clipped/inset-covered ${anchor.id}`);
          }
          const priority = (id: string) => id === anchor.id ? 2 : frame.heroes.find(hero => hero.id === id)?.alive === false ? 0 : 1;
          const ordered = [...anchors].reverse().sort((a, b) => priority(b.id) - priority(a.id));
          const labels = heroCallouts(ordered, camera, obstacles);
          inspectedStates++;
          if (labels.some((label, index) => intersects(label, camera.minimap) || labels.slice(index + 1).some(other => intersects(label, other))
            || anchors.some(point => intersects(label, { x: point.x - camera.markerRadius - 5, y: point.y - camera.markerRadius - 5, width: camera.markerRadius * 2 + 10, height: camera.markerRadius * 2 + 10 })))) crowdedStates++;
        }
      }
    }
  }
  expect(inspectedStates).toBeGreaterThan(0);
  expect(failures).toEqual([]);
  // Five heroes bunched together on a phone can't always be labelled cleanly; keep that rare.
  expect(crowdedStates / inspectedStates).toBeLessThan(0.01);
  console.info(`Camera corpus: ${catalog.scenarios.filter(entry => entry.kind === 'replay').length} clips, ${inspectedStates} frame/selection/viewport combinations, ${crowdedStates} with overlapping callouts.`);
});
