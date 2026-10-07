import { describe, expect, it } from 'vitest';
import { arenaCamera, heroCallouts, surfaceExtent } from './camera';
import type { ScreenRect } from './camera';
import { worldToScreen } from './game';

const intersects = (a: ScreenRect, b: ScreenRect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('stable, truthful encounter camera', () => {
  for (const width of [292, 362, 480, 704]) {
    for (const bounds of [
      { minX: -1840, maxX: 1840, minY: -1840, maxY: 1840 },
      { minX: -500, maxX: 500, minY: 1000, maxY: 4680 },
      { minX: -3680, maxX: 0, minY: -500, maxY: 500 },
    ]) {
      it(`keeps aspect and all boundary actors clear of the inset at ${width}px / ${bounds.maxX - bounds.minX}`, () => {
        const camera = arenaCamera(bounds, width);
        const scaleX = camera.viewport.width / (bounds.maxX - bounds.minX);
        const scaleY = camera.viewport.height / (bounds.maxY - bounds.minY);
        expect(scaleX).toBeCloseTo(scaleY, 12);
        expect(camera).toEqual(arenaCamera(bounds, width));
        for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) {
          const point = worldToScreen(bounds, x, y, camera.viewport)!;
          const glyph = { x: point.x - camera.markerRadius - 5, y: point.y - camera.markerRadius - 5, width: camera.markerRadius * 2 + 10, height: camera.markerRadius * 2 + 10 };
          expect(glyph.x).toBeGreaterThanOrEqual(0);
          expect(glyph.y).toBeGreaterThanOrEqual(0);
          expect(glyph.x + glyph.width).toBeLessThanOrEqual(camera.width);
          expect(glyph.y + glyph.height).toBeLessThanOrEqual(camera.height);
          expect(intersects(glyph, camera.minimap)).toBe(false);
        }
        expect(camera.markerRadius * 2).toBeGreaterThanOrEqual(36);
      });
    }
  }

  it('extends context terrain across the surface with the identical world transform', () => {
    const bounds = { minX: -500, maxX: 500, minY: 1000, maxY: 4680 };
    for (const width of [292, 704]) {
      const camera = arenaCamera(bounds, width);
      for (const margin of [0, 40]) {
        const extent = surfaceExtent(bounds, camera, margin);
        expect(extent.viewport).toEqual({ left: -margin, top: -margin, width: camera.width + margin * 2, height: camera.height + margin * 2 });
        expect(extent.bounds.minX).toBeLessThanOrEqual(bounds.minX);
        expect(extent.bounds.maxY).toBeGreaterThanOrEqual(bounds.maxY);
        for (const [x, y] of [[-500, 1000], [123, 2345], [500, 4680], [-2000, 9000]]) {
          const expected = worldToScreen(bounds, x, y, camera.viewport)!;
          const actual = worldToScreen(extent.bounds, x, y, extent.viewport)!;
          expect(actual.x).toBeCloseTo(expected.x, 8);
          expect(actual.y).toBeCloseTo(expected.y, 8);
        }
      }
    }
  });

  it('separates four clustered callouts without moving their actual anchors', () => {
    for (const width of [292, 362, 704]) {
      const camera = arenaCamera({ minX: -500, maxX: 500, minY: -500, maxY: 500 }, width);
      const centre = worldToScreen({ minX: -500, maxX: 500, minY: -500, maxY: 500 }, 0, 0, camera.viewport)!;
      const anchors = [
        { id: 'a', name: 'Templar Assassin', ...centre },
        { id: 'b', name: 'Windranger', x: centre.x + 3, y: centre.y + 4 },
        { id: 'c', name: 'Snapfire', x: centre.x - 2, y: centre.y + 2 },
        { id: 'd', name: 'Tusk', x: centre.x - 6, y: centre.y - 3 },
      ];
      const original = structuredClone(anchors);
      const labels = heroCallouts(anchors, camera);
      expect(anchors).toEqual(original);
      expect(labels).toHaveLength(4);
      for (const label of labels) {
        expect(label.x).toBeGreaterThanOrEqual(8);
        expect(label.y).toBeGreaterThanOrEqual(8);
        expect(label.x + label.width).toBeLessThanOrEqual(camera.width - 8);
        expect(label.y + label.height).toBeLessThanOrEqual(camera.height - 8);
        expect(intersects(label, camera.minimap)).toBe(false);
        for (const other of labels) if (other.id !== label.id) expect(intersects(label, other)).toBe(false);
        for (const point of anchors) expect(intersects(label, {
          x: point.x - camera.markerRadius, y: point.y - camera.markerRadius,
          width: camera.markerRadius * 2, height: camera.markerRadius * 2,
        })).toBe(false);
      }
    }
  });
});
