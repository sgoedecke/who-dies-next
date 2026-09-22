import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clientMapSchema } from '../shared/client-map';
import type { ClientMap } from '../shared/client-map';
import { scenarioSchema } from '../shared/scenario';
import type { Frame, Scenario } from '../shared/scenario';
import { MAX_MATCH_AGE_SECONDS } from '../shared/recent';
import { ClientMapLayers, ClientMinimap, croppedHeightCells, fullMapBounds, heightBandPaths, minimapCrop, minimapViewport, referenceHeightColor, sampledHeightContours } from './ClientMap';
import { ObservedMapLayers } from './MapLayers';
import { frameAt, worldToScreen } from './game';

const publishedMap = clientMapSchema.parse(JSON.parse(readFileSync('public/maps/dota-6934.json', 'utf8')));
const publishedScenario = scenarioSchema.parse(JSON.parse(readFileSync('public/scenarios/replay-9009355617-298767.json', 'utf8')));
const now = Date.parse('2026-09-22T00:00:00Z');
const bounds = { minX: 0, maxX: 256, minY: 0, maxY: 128 };
const scenario: Scenario = { ...publishedScenario, bounds };
const map: ClientMap = {
  ...publishedMap,
  source: {
    ...publishedMap.source,
    heightValidation: { method: 'default-world-collision', maxDeviation: 0, checkedSamples: 6, matchedSamples: 6, rejectedSamples: 0 },
  },
  elevation: {
    source: 'vhcg-v1', minX: 0, minY: 0, cellSize: 64, width: 4, height: 2,
    rows: [[[1, null], [1, 0], [2, 128]], [[2, 256], [1, null], [1, 512]]],
  },
  trees: [{ x: 64, y: 64, z: 0, layer: 'default' }, { x: 500, y: 500, z: 0, layer: 'outside' }],
};

function renderReference(candidate = scenario, reference: ClientMap | null = map): string {
  return renderToStaticMarkup(h('div', null,
    h('svg', null, h(ClientMapLayers, { map: reference, scenario: candidate, nowMs: now })),
    h(ClientMinimap, { map: reference, scenario: candidate, frame: candidate.startSnapshot, nowMs: now })));
}

describe('cropped current-client reference layer', () => {
  it('decodes RLE southwest-to-northeast, shares the hero transform, and omits null heights', () => {
    expect(croppedHeightCells(map, bounds)).toEqual([
      { x: 217.5, y: 245, width: 162.5, height: 190, value: 0 },
      { x: 380, y: 245, width: 325, height: 190, value: 128 },
      { x: 55, y: 55, width: 325, height: 190, value: 256 },
      { x: 542.5, y: 55, width: 162.5, height: 190, value: 512 },
    ]);
    expect(clientMapSchema.safeParse(map).success).toBe(true);
  });
  it('clips boundary samples to the encounter bounds instead of stretching a whole world map', () => {
    const crop = { minX: 96, maxX: 224, minY: 32, maxY: 96 };
    const cells = croppedHeightCells(map, crop);
    expect(cells[0]).toEqual({ x: 55, y: 245, width: 162.5, height: 190, value: 0 });
    for (const cell of cells) {
      expect(cell.x).toBeGreaterThanOrEqual(55);
      expect(cell.y).toBeGreaterThanOrEqual(55);
      expect(cell.x + cell.width).toBeLessThanOrEqual(705);
      expect(cell.y + cell.height).toBeLessThanOrEqual(435);
    }
    expect(croppedHeightCells(map, { minX: 1000, maxX: 1200, minY: 1000, maxY: 1200 })).toEqual([]);
  });
  it('renders only an exactly matched recent replay and recent client reference', () => {
    expect(renderReference()).toContain('client-height-cell');
    expect(renderReference({ ...scenario, source: { ...scenario.source, replaySha256: '0'.repeat(64) } })).not.toContain('client-height-cell');
    if (scenario.source.kind !== 'replay') throw new Error('Expected replay');
    expect(renderReference({ ...scenario, source: { ...scenario.source, replaySha256: '0'.repeat(64) } })).not.toContain('client-height-cell');
    expect(renderReference({ ...scenario, source: { ...scenario.source, matchId: 'different-match' } })).not.toContain('client-height-cell');
    expect(renderReference({ ...scenario, source: { ...scenario.source, matchStartTime: Math.floor(now / 1000) - MAX_MATCH_AGE_SECONDS - 1 } })).not.toContain('client-height-cell');
    expect(renderReference(scenario, { ...map, source: { ...map.source, manifestTime: Math.floor(now / 1000) - MAX_MATCH_AGE_SECONDS - 1 } })).not.toContain('client-height-cell');
    expect(renderReference(scenario, null)).not.toContain('client-map-reference');
    expect(renderReference(scenario, null)).not.toContain('client-minimap');
    expect(renderReference({ ...scenario, source: { ...scenario.source, replaySha256: '0'.repeat(64) } })).not.toContain('client-minimap');
  });
  it('renders baseline canopy symbols and shadows without claiming that trees are standing', () => {
    const html = renderReference();
    expect(html).toContain('class="client-base-tree" transform="translate(217.5,245)"');
    expect(html.match(/class="client-base-tree"/g)).toHaveLength(1);
    expect(html).toContain('Base tree; current state unknown');
    expect(html).toContain('reference-tree-canopy');
    expect(html).toContain('reference-tree-shadow');
    expect(referenceHeightColor(0)).not.toBe(referenceHeightColor(512));
    expect(referenceHeightColor(128)).toBe(referenceHeightColor(191));
  });
  it('groups equal absolute height bands without coloring null cells or normalizing each crop independently', () => {
    const paths = heightBandPaths(croppedHeightCells(map, bounds));
    expect(paths.map(value => value.band)).toEqual([0, 2, 4, 8]);
    expect(paths[0].path).toBe('M217.5 245h162.5v190h-162.5Z');
    expect(paths.map(value => value.path).join('')).not.toContain('M55 245');
    const smaller = heightBandPaths(croppedHeightCells(map, { minX: 128, maxX: 256, minY: 0, maxY: 64 }));
    expect(smaller.map(value => value.band)).toEqual([2]);
    expect(referenceHeightColor(smaller[0].band * 64)).toBe(referenceHeightColor(paths[1].band * 64));
  });
  it('draws sampled contour boundaries only between known unequal bands', () => {
    const contours = sampledHeightContours(map, bounds);
    expect(contours.minor).toBe('');
    expect(contours.major.match(/M/g)).toHaveLength(3);
    expect(contours.major).toContain('M380.00 435.00L380.00 245.00');
    expect(contours.major).not.toContain('M217.50 435.00');
    const flat: ClientMap = { ...map, elevation: { ...map.elevation, rows: [[[4, 128]], [[4, 128]]] } };
    expect(sampledHeightContours(flat, bounds)).toEqual({ major: '', minor: '' });
  });
  it('projects the full map north-up and locates/clips the encounter rectangle in the same world frame', () => {
    expect(fullMapBounds(map)).toEqual(bounds);
    expect(worldToScreen(bounds, 0, 0, minimapViewport)).toEqual({ x: 4, y: 196 });
    expect(worldToScreen(bounds, 256, 128, minimapViewport)).toEqual({ x: 196, y: 4 });
    expect(minimapCrop(map, { minX: 64, maxX: 192, minY: 32, maxY: 96 })).toEqual({ x: 52, y: 52, width: 96, height: 96 });
    expect(minimapCrop(map, { minX: -64, maxX: 320, minY: -64, maxY: 256 })).toEqual({ x: 4, y: 4, width: 192, height: 192 });
    const cells = croppedHeightCells(map, bounds, minimapViewport);
    expect(cells[0]).toEqual({ x: 52, y: 100, width: 48, height: 96, value: 0 });
    expect(cells[2]).toEqual({ x: 4, y: 4, width: 96, height: 96, value: 256 });
    const html = renderReference();
    expect(html).toContain('Full verified client map, north up');
    expect(html).toContain('class="minimap-crop" x="4" y="4" width="192" height="192"');
    expect(html).not.toContain('<summary>');
  });
  it('preserves authoritative observed tower/tree sampling above the static reference', () => {
    const tower = { id: 'observed-tower', name: 'Tower', team: 'radiant' as const, x: 64, y: 64, z: 0, hp: 100, maxHp: 100, alive: true };
    const tree = { id: 'observed-tree', x: 64, y: 64, z: 0, alive: true };
    const setup: Frame = { time: 0, heroes: [], towers: [tower], trees: [tree] };
    const later: Frame = { time: 5, heroes: [], towers: [{ ...tower, hp: 0, alive: false }], trees: [{ ...tree, alive: false }] };
    const clip = { duration: 10, frames: [setup, later, { ...later, time: 10 }] };
    const render = (time: number) => renderToStaticMarkup(h('svg', null,
      h(ClientMapLayers, { map, scenario, nowMs: now }),
      h(ObservedMapLayers, { frame: frameAt(clip, time), bounds })));
    expect(render(0).indexOf('client-height-cell')).toBeLessThan(render(0).indexOf('observed-map-layers'));
    expect(render(4.9)).not.toContain('tower-destroyed-cross');
    expect(render(5)).toContain('tower-destroyed-cross');
    expect(render(5)).toContain('tree-stump');
    expect(render(0)).toContain('alive, HP 100');
    expect(render(5)).toContain('Base tree; current state unknown');
  });
});
