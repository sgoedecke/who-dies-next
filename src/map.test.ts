import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../shared/scenario';
import { frameAt, worldToScreen } from './game';
import { ObservedMapLayers } from './MapLayers';

const bounds = { minX: -100, maxX: 100, minY: -200, maxY: 200 };
const tower = { id: 'tower', name: 'npc_dota_goodguys_tower1_mid', team: 'radiant' as const, x: 0, y: 0, z: 256, hp: 1000, maxHp: 1800, alive: true };
const tree = { id: 'tree', x: 0, y: 0, z: 256, alive: true };
const initial: Frame = { time: 0, heroes: [], towers: [tower], trees: [tree] };
const destroyed: Frame = { time: 5, heroes: [], towers: [{ ...tower, hp: 0, alive: false }], trees: [{ ...tree, alive: false }] };
const final: Frame = { ...destroyed, time: 10 };
const sample = { duration: 10, frames: [initial, destroyed, final] };
const renderLayers = (frame: Frame) => renderToStaticMarkup(h('svg', null, h(ObservedMapLayers, { frame, bounds })));

describe('aligned observed map layers', () => {
  it('maps world positions through one shared transform with an inverted screen Y axis', () => {
    expect(worldToScreen(bounds, -100, -200)).toEqual({ x: 55, y: 435 });
    expect(worldToScreen(bounds, 100, 200)).toEqual({ x: 705, y: 55 });
    expect(worldToScreen(bounds, 0, 0)).toEqual({ x: 380, y: 245 });
    expect(worldToScreen(bounds, null, 0)).toBeNull();
    expect(worldToScreen(bounds, 0, null)).toBeNull();
  });
  it('aligns a tree and tower at the same coordinates, independently of object Z', () => {
    const html = renderLayers(initial);
    expect(html.match(/translate\(380,245\)/g)).toHaveLength(2);
    expect(renderLayers({ ...initial, towers: [{ ...tower, z: 9999 }], trees: [{ ...tree, z: null }] })).toBe(html);
  });
  it('preserves map observations while interpolating a hero frame and steps destruction only at the next sample', () => {
    expect(frameAt(sample, 2.5).towers).toEqual(initial.towers);
    expect(frameAt(sample, 2.5).trees).toEqual(initial.trees);
    expect(renderLayers(frameAt(sample, 4.99))).not.toContain('tower-destroyed-cross');
    expect(renderLayers(frameAt(sample, 5))).toContain('tower-destroyed-cross');
    expect(renderLayers(frameAt(sample, 5))).toContain('tree-stump');
    expect(initial.towers?.[0].alive).toBe(true);
    expect(initial.trees?.[0].alive).toBe(true);
  });
  it('never generates trees or towers when no observations are available', () => {
    const absent = renderLayers({ time: 0, heroes: [], trees: null });
    expect(absent).not.toContain('data-map-entity');
    const unknown = renderLayers({ time: 0, heroes: [], towers: [{ ...tower, x: null }], trees: [{ ...tree, y: null }] });
    expect(unknown).not.toContain('data-map-entity');
  });
  it('marks uncertain alive state rather than claiming a living tower or tree', () => {
    const html = renderLayers({ time: 0, heroes: [], towers: [{ ...tower, alive: null }], trees: [{ ...tree, alive: null }] });
    expect(html.match(/unknown-state/g)).toHaveLength(2);
    expect(html).toContain('state unknown');
  });
  it('hides off-crop entity anchors without clipping the glyphs of boundary entities', () => {
    const outside = renderLayers({ ...initial, towers: [{ ...tower, x: bounds.maxX + 1 }], trees: [{ ...tree, y: bounds.minY - 1 }] });
    expect(outside.match(/display="none"/g)).toHaveLength(2);
    const boundary = renderLayers({ ...initial, towers: [{ ...tower, x: bounds.maxX, y: bounds.minY }] });
    expect(boundary).not.toContain('display="none"');
    expect(boundary).not.toContain('clip-path');
    expect(boundary).toContain('1000</text>');
  });
});
