import { memo, useEffect, useId, useMemo, useState } from 'react';
import { clientMapEligibility, clientMapSchema } from '../shared/client-map';
import type { ClientMap } from '../shared/client-map';
import type { Frame, Scenario } from '../shared/scenario';
import { MAP_VIEWPORT, worldToScreen } from './game';
import type { MapViewport } from './game';
import { publicUrl } from './public-url';

export function useClientMap(): ClientMap | null {
  const [map, setMap] = useState<ClientMap | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(publicUrl('/maps/dota-6934.json'), { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (controller.signal.aborted) return;
        const result = clientMapSchema.safeParse(data);
        if (result.success) setMap(result.data);
      })
      .catch(() => { /* Reference geometry is optional; replay observations remain usable. */ });
    return () => controller.abort();
  }, []);
  return map;
}

export interface HeightCell {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

/** Adjacent equal-height samples share a rectangle; null samples never acquire a surface. */
export function croppedHeightCells(map: ClientMap, bounds: Scenario['bounds'],
  viewport: MapViewport = MAP_VIEWPORT): HeightCell[] {
  const grid = map.elevation;
  const cells: HeightCell[] = [];
  const firstColumn = Math.max(0, Math.floor((bounds.minX - grid.minX) / grid.cellSize));
  const lastColumn = Math.min(grid.width, Math.ceil((bounds.maxX - grid.minX) / grid.cellSize));
  const firstRow = Math.max(0, Math.floor((bounds.minY - grid.minY) / grid.cellSize));
  const lastRow = Math.min(grid.height, Math.ceil((bounds.maxY - grid.minY) / grid.cellSize));
  for (let row = firstRow; row < lastRow; row++) {
    const minY = Math.max(bounds.minY, grid.minY + row * grid.cellSize);
    const maxY = Math.min(bounds.maxY, grid.minY + (row + 1) * grid.cellSize);
    let column = 0;
    for (const [count, value] of grid.rows[row]) {
      const end = column + count;
      const startVisible = Math.max(column, firstColumn);
      const endVisible = Math.min(end, lastColumn);
      if (value !== null && startVisible < endVisible) {
        const minX = Math.max(bounds.minX, grid.minX + startVisible * grid.cellSize);
        const maxX = Math.min(bounds.maxX, grid.minX + endVisible * grid.cellSize);
        const southwest = worldToScreen(bounds, minX, minY, viewport)!;
        const northeast = worldToScreen(bounds, maxX, maxY, viewport)!;
        cells.push({ x: southwest.x, y: northeast.y, width: northeast.x - southwest.x, height: southwest.y - northeast.y, value });
      }
      column = end;
      if (column >= lastColumn) break;
    }
  }
  return cells;
}

export function heightBand(value: number): number {
  return Math.floor(value / 64);
}

export function referenceHeightColor(value: number): string {
  const colors = ['#1d404b', '#294d49', '#3c5340', '#4b6147', '#62704f', '#727953', '#7e805b', '#85815f', '#91876a'];
  return colors[Math.max(0, Math.min(colors.length - 1, heightBand(value)))];
}

export function heightBandPaths(cells: HeightCell[]): Array<{ band: number; path: string }> {
  const bands = new Map<number, string[]>();
  for (const cell of cells) {
    const band = heightBand(cell.value);
    const paths = bands.get(band) ?? [];
    const number = (value: number) => Number(value.toFixed(3));
    paths.push(`M${number(cell.x)} ${number(cell.y)}h${number(cell.width)}v${number(cell.height)}h${number(-cell.width)}Z`);
    bands.set(band, paths);
  }
  return [...bands].sort(([a], [b]) => a - b).map(([band, paths]) => ({ band, path: paths.join('') }));
}

const decodedHeights = new WeakMap<ClientMap, Float64Array>();

function heightSamples(map: ClientMap): Float64Array {
  const cached = decodedHeights.get(map);
  if (cached) return cached;
  const grid = map.elevation;
  const samples = new Float64Array(grid.width * grid.height).fill(NaN);
  grid.rows.forEach((row, index) => {
    let column = 0;
    for (const [count, value] of row) {
      if (value !== null) samples.fill(value, index * grid.width + column, index * grid.width + column + count);
      column += count;
    }
  });
  decodedHeights.set(map, samples);
  return samples;
}

/** Boundaries join known height bands only, never treating missing samples as low ground. */
export function sampledHeightContours(map: ClientMap, bounds: Scenario['bounds'], viewport: MapViewport = MAP_VIEWPORT): { major: string; minor: string } {
  const grid = map.elevation;
  const samples = heightSamples(map);
  const segments: { major: string[]; minor: string[] } = { major: [], minor: [] };
  const firstX = Math.max(0, Math.floor((bounds.minX - grid.minX) / grid.cellSize));
  const lastX = Math.min(grid.width, Math.ceil((bounds.maxX - grid.minX) / grid.cellSize));
  const firstY = Math.max(0, Math.floor((bounds.minY - grid.minY) / grid.cellSize));
  const lastY = Math.min(grid.height, Math.ceil((bounds.maxY - grid.minY) / grid.cellSize));
  const add = (a: number, b: number, x1: number, y1: number, x2: number, y2: number) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || heightBand(a) === heightBand(b)) return;
    const from = worldToScreen(bounds, Math.max(bounds.minX, x1), Math.max(bounds.minY, y1), viewport)!;
    const to = worldToScreen(bounds, Math.min(bounds.maxX, x2), Math.min(bounds.maxY, y2), viewport)!;
    const key = Math.abs(heightBand(a) - heightBand(b)) >= 2 ? 'major' : 'minor';
    segments[key].push(`M${from.x.toFixed(2)} ${from.y.toFixed(2)}L${to.x.toFixed(2)} ${to.y.toFixed(2)}`);
  };
  for (let row = firstY; row < lastY; row++) {
    for (let column = firstX; column < lastX; column++) {
      const value = samples[row * grid.width + column];
      const x = grid.minX + column * grid.cellSize;
      const y = grid.minY + row * grid.cellSize;
      if (column + 1 < grid.width && x + grid.cellSize < bounds.maxX) add(value, samples[row * grid.width + column + 1], x + grid.cellSize, y, x + grid.cellSize, y + grid.cellSize);
      if (row + 1 < grid.height && y + grid.cellSize < bounds.maxY) add(value, samples[(row + 1) * grid.width + column], x, y + grid.cellSize, x + grid.cellSize, y + grid.cellSize);
    }
  }
  return { major: segments.major.join(''), minor: segments.minor.join('') };
}

export function fullMapBounds(map: ClientMap): Scenario['bounds'] {
  const grid = map.elevation;
  return { minX: grid.minX, minY: grid.minY, maxX: grid.minX + grid.width * grid.cellSize, maxY: grid.minY + grid.height * grid.cellSize };
}

export const minimapViewport = { left: 4, top: 4, width: 192, height: 192 };

export function minimapCrop(map: ClientMap, bounds: Scenario['bounds']): { x: number; y: number; width: number; height: number } {
  const full = fullMapBounds(map);
  const clampX = (value: number) => Math.max(full.minX, Math.min(full.maxX, value));
  const clampY = (value: number) => Math.max(full.minY, Math.min(full.maxY, value));
  const southwest = worldToScreen(full, clampX(bounds.minX), clampY(bounds.minY), minimapViewport)!;
  const northeast = worldToScreen(full, clampX(bounds.maxX), clampY(bounds.maxY), minimapViewport)!;
  return { x: southwest.x, y: northeast.y, width: northeast.x - southwest.x, height: southwest.y - northeast.y };
}

export const ClientMinimap = memo(function ClientMinimap({ map, scenario, frame, nowMs, size, inset }: {
  map: ClientMap | null; scenario: Scenario; frame: Frame; nowMs: number;
  size?: number; inset?: number;
}) {
  const paths = useMemo(() => map ? heightBandPaths(croppedHeightCells(map, fullMapBounds(map), minimapViewport)) : [], [map]);
  if (!map || !clientMapEligibility(map, scenario, nowMs).eligible) return null;
  const bounds = fullMapBounds(map);
  const crop = minimapCrop(map, scenario.bounds);
  return <svg className="client-minimap" viewBox="0 0 200 200" role="img" aria-label="Full verified client map, north up; outlined rectangle is the encounter crop"
    data-client-map={map.id} style={size === undefined ? undefined : { width: size, right: inset, bottom: inset }}>
    <title>Current-client sampled heights; exact replay build unverified. North is up.</title>
    <rect width="200" height="200" rx="4" fill="#111d20" />
    <g className="minimap-height-bands">{paths.map(({ band, path }) => <path key={band} d={path} fill={referenceHeightColor(band * 64)} />)}</g>
    <rect className="minimap-crop" x={crop.x} y={crop.y} width={crop.width} height={crop.height} />
    {frame.heroes.filter(hero => hero.x !== null && hero.y !== null && hero.x >= bounds.minX && hero.x <= bounds.maxX && hero.y >= bounds.minY && hero.y <= bounds.maxY).map(hero => {
      const point = worldToScreen(bounds, hero.x, hero.y, minimapViewport)!;
      return <circle key={hero.id} className={`minimap-hero ${hero.team} ${hero.alive === false ? 'dead' : ''}`} cx={point.x} cy={point.y} r="2">
        <title>{hero.name}</title>
      </circle>;
    })}
  </svg>;
});

export const ClientMapLayers = memo(function ClientMapLayers({ map, scenario, nowMs, viewport = MAP_VIEWPORT }: {
  map: ClientMap | null;
  scenario: Scenario;
  nowMs: number;
  viewport?: MapViewport;
}) {
  const clipId = useId().replaceAll(':', '');
  const cells = useMemo(() => map ? croppedHeightCells(map, scenario.bounds, viewport) : [], [map, scenario.bounds, viewport]);
  const paths = useMemo(() => heightBandPaths(cells), [cells]);
  const contours = useMemo(() => map ? sampledHeightContours(map, scenario.bounds, viewport) : { major: '', minor: '' }, [map, scenario.bounds, viewport]);
  const baseTrees = useMemo(() => map?.trees.filter(tree => tree.x >= scenario.bounds.minX && tree.x <= scenario.bounds.maxX
    && tree.y >= scenario.bounds.minY && tree.y <= scenario.bounds.maxY) ?? [], [map, scenario.bounds]);
  const treeScale = Math.max(0.4, Math.min(0.7, viewport.width / 650));
  if (!map || !clientMapEligibility(map, scenario, nowMs).eligible) return null;
  return <g className="client-map-reference" data-client-map={map.id} clipPath={`url(#${clipId})`}>
    <defs><clipPath id={clipId}><rect x={viewport.left} y={viewport.top} width={viewport.width} height={viewport.height} /></clipPath></defs>
    <g className="client-height-layer" role="img" aria-label="Sampled current-client elevation; exact replay build unverified">
      {paths.map(({ band, path }) => <path key={band} className="client-height-cell" d={path} fill={referenceHeightColor(band * 64)} data-height-band={band}>
        <title>{`${band * 64}–${(band + 1) * 64} world units · sampled height band, not an exact cliff or pathing boundary`}</title>
      </path>)}
      <path className="height-contour minor" d={contours.minor} />
      <path className="height-contour major" d={contours.major} />
    </g>
    <g className="client-base-tree-layer" role="img" aria-label="Client base tree positions; current state unknown">
      {baseTrees.map((tree, index) => {
        const point = worldToScreen(scenario.bounds, tree.x, tree.y, viewport)!;
        return <g key={index} className="client-base-tree" transform={`translate(${point.x},${point.y})`}
          data-source-layer={tree.layer} aria-label="Base tree; current state unknown">
          <title>Base tree; current state unknown</title>
          <g transform={`scale(${treeScale})`}>
            <ellipse className="reference-tree-shadow" cx="2" cy="5" rx="8" ry="4" />
            <path className="reference-tree-trunk" d="M0 2V9" />
            <path className="reference-tree-canopy" d="M0 -9C-6 -10 -9 -6 -7 -2C-10 3 -6 7 0 5C6 7 10 3 7 -2C9 -6 6 -10 0 -9Z" />
            <path className="reference-tree-highlight" d="M-4 -3Q-3 -7 1 -6" />
          </g>
        </g>;
      })}
    </g>
  </g>;
});
