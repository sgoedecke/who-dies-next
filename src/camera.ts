import type { Scenario } from '../shared/scenario';
import type { MapViewport } from './game';

export interface ScreenRect { x: number; y: number; width: number; height: number }
export interface ArenaCamera {
  width: number;
  height: number;
  viewport: MapViewport;
  markerRadius: number;
  minimap: ScreenRect;
  minimapInset: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** One uniform, time-independent transform; reserve inset clearance without expanding world bounds. */
export function arenaCamera(bounds: Scenario['bounds'], measuredWidth: number): ArenaCamera {
  const width = Math.max(260, Math.round(measuredWidth));
  const compact = width < 520;
  const markerRadius = compact ? 18 : 23;
  const minimapInset = compact ? 9 : 12;
  const size = clamp(width * (compact ? 0.21 : 0.18), compact ? 72 : 82, compact ? 104 : 128);
  const top = 44;
  const insetClearance = size + minimapInset + markerRadius + 8;
  const right = compact ? 32 : insetClearance;
  const bottom = compact ? insetClearance : 44;
  const availableWidth = width - 32 - right;
  const worldWidth = bounds.maxX - bounds.minX;
  const worldHeight = bounds.maxY - bounds.minY;
  const height = Math.round(clamp(availableWidth * worldHeight / worldWidth + top + bottom, compact ? 340 : 360, compact ? 410 : 540));
  const availableHeight = height - top - bottom;
  const scale = Math.min(availableWidth / worldWidth, availableHeight / worldHeight);
  const viewport = {
    left: 32 + (availableWidth - worldWidth * scale) / 2,
    top: top + (availableHeight - worldHeight * scale) / 2,
    width: worldWidth * scale,
    height: worldHeight * scale,
  };
  return {
    width, height, viewport, markerRadius, minimapInset,
    minimap: { x: width - minimapInset - size, y: height - minimapInset - size, width: size, height: size },
  };
}

/**
 * World bounds and screen viewport covering the whole arena surface (plus an optional
 * margin), using exactly the same linear transform as the encounter viewport. Context
 * terrain can then fill the panel without moving any recorded actor.
 */
export function surfaceExtent(bounds: Scenario['bounds'], camera: Pick<ArenaCamera, 'width' | 'height' | 'viewport'>, margin = 0): {
  bounds: Scenario['bounds']; viewport: MapViewport;
} {
  const { viewport } = camera;
  const scale = viewport.width / (bounds.maxX - bounds.minX);
  const x0 = -margin, x1 = camera.width + margin, y0 = -margin, y1 = camera.height + margin;
  return {
    bounds: {
      minX: bounds.minX + (x0 - viewport.left) / scale,
      maxX: bounds.minX + (x1 - viewport.left) / scale,
      minY: bounds.maxY - (y1 - viewport.top) / scale,
      maxY: bounds.maxY - (y0 - viewport.top) / scale,
    },
    viewport: { left: x0, top: y0, width: x1 - x0, height: y1 - y0 },
  };
}

export interface LabelAnchor { id: string; name: string; x: number; y: number }
export interface HeroCallout extends ScreenRect {
  id: string;
  leader: { x: number; y: number };
}

const calloutWidth = (name: string) => clamp(name.length * 6.4 + 28, 112, 164);

function overlap(a: ScreenRect, b: ScreenRect, gap = 5): number {
  return Math.max(0, Math.min(a.x + a.width + gap, b.x + b.width) - Math.max(a.x - gap, b.x))
    * Math.max(0, Math.min(a.y + a.height + gap, b.y + b.height) - Math.max(a.y - gap, b.y));
}

/** Labels may move with leader lines; the supplied world-coordinate anchors never move. */
function greedyCallouts(anchors: LabelAnchor[], camera: ArenaCamera, obstacles: ScreenRect[]): HeroCallout[] {
  const radius = camera.markerRadius + 6;
  const occupied = [
    camera.minimap,
    ...anchors.map(point => ({ x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 })),
    ...obstacles,
  ];
  const result: HeroCallout[] = [];
  for (const anchor of anchors) {
    const width = calloutWidth(anchor.name);
    const height = 46;
    const gap = radius + 10;
    const candidates: ScreenRect[] = [
      { x: anchor.x - width / 2, y: anchor.y - gap - height, width, height },
      { x: anchor.x - width / 2, y: anchor.y + gap, width, height },
      { x: anchor.x + gap, y: anchor.y - height / 2, width, height },
      { x: anchor.x - gap - width, y: anchor.y - height / 2, width, height },
    ];
    for (let y = 8; y <= camera.height - height - 8; y += height + 10) {
      for (const x of [8, (camera.width - width) / 2, camera.width - width - 8]) {
        candidates.push({ x, y, width, height });
      }
    }
    const positioned = candidates.map(candidate => ({
      ...candidate,
      x: clamp(candidate.x, 8, camera.width - width - 8),
      y: clamp(candidate.y, 8, camera.height - height - 8),
    }));
    const collision = (rect: ScreenRect) => occupied.reduce((sum, other) => sum + overlap(rect, other), 0);
    const score = (rect: ScreenRect) => collision(rect) * 10_000
      + Math.hypot(rect.x + width / 2 - anchor.x, rect.y + height / 2 - anchor.y);
    let best = positioned[0];
    let bestScore = score(best);
    const consider = (candidate: ScreenRect) => {
      const value = score(candidate);
      if (value < bestScore) { best = candidate; bestScore = value; }
    };
    positioned.slice(1).forEach(consider);
    if (collision(best) > 0) {
      const xs = [8, camera.width - width - 8, ...occupied.flatMap(rect => [rect.x - width - 7, rect.x + rect.width + 7])];
      const ys = [8, camera.height - height - 8, ...occupied.flatMap(rect => [rect.y - height - 7, rect.y + rect.height + 7])];
      for (const x of xs) for (const y of ys) {
        consider({ x: clamp(x, 8, camera.width - width - 8), y: clamp(y, 8, camera.height - height - 8), width, height });
      }
    }
    result.push({
      id: anchor.id, ...best,
      leader: { x: clamp(anchor.x, best.x, best.x + width), y: clamp(anchor.y, best.y, best.y + height) },
    });
    occupied.push(best);
  }
  return result;
}

export function heroCallouts(anchors: LabelAnchor[], camera: ArenaCamera, obstacles: ScreenRect[] = []): HeroCallout[] {
  const initial = greedyCallouts(anchors, camera, obstacles);
  const radius = camera.markerRadius + 5;
  const protectedAreas = [
    camera.minimap,
    ...anchors.map(point => ({ x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2 })),
  ];
  const clear = (rect: ScreenRect, areas: ScreenRect[]) => areas.every(other => overlap(rect, other, 1.5) === 0);
  if (initial.every((label, index) => clear(label, [...protectedAreas, ...initial.slice(index + 1)]))) return initial;

  // A greedy placement can trap the last label. At most four participants make
  // a bounded joint search practical; only callouts move, never hero anchors.
  const ordered = [...anchors].sort((a, b) => b.name.length - a.name.length);
  for (const fixed of [[...protectedAreas, ...obstacles], protectedAreas]) {
    let attempts = 0;
    const search = (index: number, placed: HeroCallout[]): HeroCallout[] | null => {
      if (index === ordered.length) return placed;
      if (++attempts > 10_000) return null;
      const anchor = ordered[index];
      const width = calloutWidth(anchor.name);
      const height = 46;
      const occupied = [...fixed, ...placed];
      const xs = [8, camera.width - width - 8, anchor.x - width / 2,
        ...occupied.flatMap(rect => [rect.x - width - 3, rect.x + rect.width + 3])];
      const ys = [8, camera.height - height - 8, anchor.y - height / 2,
        ...occupied.flatMap(rect => [rect.y - height - 3, rect.y + rect.height + 3])];
      const candidates: ScreenRect[] = [];
      const seen = new Set<string>();
      for (const x of xs) for (const y of ys) {
        const candidate = { x: clamp(x, 8, camera.width - width - 8), y: clamp(y, 8, camera.height - height - 8), width, height };
        const key = `${candidate.x.toFixed(3)}:${candidate.y.toFixed(3)}`;
        if (!seen.has(key) && clear(candidate, occupied)) candidates.push(candidate);
        seen.add(key);
      }
      const distance = (rect: ScreenRect) => Math.hypot(rect.x + width / 2 - anchor.x, rect.y + height / 2 - anchor.y);
      candidates.sort((a, b) => distance(a) - distance(b));
      for (const rect of candidates) {
        const result = search(index + 1, [...placed, {
          id: anchor.id, ...rect,
          leader: { x: clamp(anchor.x, rect.x, rect.x + width), y: clamp(anchor.y, rect.y, rect.y + height) },
        }]);
        if (result) return result;
      }
      return null;
    };
    const packed = search(0, []);
    if (packed) return packed;
  }
  return initial;
}
