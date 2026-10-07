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
  const colors = ['#1f4d63', '#355c48', '#3d5d37', '#4a6a3d', '#5a7543', '#677b47', '#757f4e', '#837f56', '#8f8562'];
  return colors[Math.max(0, Math.min(colors.length - 1, heightBand(value)))];
}

/** Deterministic per-tree variation so canopies don't read as a stamped pattern. */
function treeVariation(x: number, y: number): { scale: number; tone: number; turn: number } {
  const hash = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  const second = Math.abs(Math.sin(x * 39.3468 + y * 11.135) * 24634.6345) % 1;
  return { scale: 0.85 + hash * 0.4, tone: second, turn: Math.round((hash - 0.5) * 50) };
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

export const ClientMapLayers = memo(function ClientMapLayers({ map, scenario, nowMs, viewport = MAP_VIEWPORT, bounds = scenario.bounds, clip = viewport }: {
  map: ClientMap | null;
  scenario: Scenario;
  nowMs: number;
  viewport?: MapViewport;
  /** World extent rendered into `viewport`; defaults to the encounter crop. */
  bounds?: Scenario['bounds'];
  /** Visible screen rectangle; may be smaller than `viewport` so blurred edges bleed off-surface. */
  clip?: MapViewport;
}) {
  const id = useId().replaceAll(':', '');
  const cells = useMemo(() => map ? croppedHeightCells(map, bounds, viewport) : [], [map, bounds, viewport]);
  const paths = useMemo(() => heightBandPaths(cells), [cells]);
  const contours = useMemo(() => map ? sampledHeightContours(map, bounds, viewport) : { major: '', minor: '' }, [map, bounds, viewport]);
  const baseTrees = useMemo(() => map?.trees.filter(tree => tree.x >= bounds.minX && tree.x <= bounds.maxX
    && tree.y >= bounds.minY && tree.y <= bounds.maxY) ?? [], [map, bounds]);
  if (!map || !clientMapEligibility(map, scenario, nowMs).eligible) return null;
  const pixelsPerUnit = viewport.width / (bounds.maxX - bounds.minX);
  const cellPixels = map.elevation.cellSize * pixelsPerUnit;
  const soften = Math.max(0.8, Math.min(7, cellPixels * 0.32));
  const shade = Math.max(1.5, Math.min(6, cellPixels * 0.2));
  const treeScale = Math.max(0.5, Math.min(1.1, pixelsPerUnit * 2.6));
  return <g className="client-map-reference" data-client-map={map.id} clipPath={`url(#${id}-clip)`}>
    <defs>
      <clipPath id={`${id}-clip`}><rect x={clip.left} y={clip.top} width={clip.width} height={clip.height} /></clipPath>
      <filter id={`${id}-soften`} x="-2%" y="-2%" width="104%" height="104%"><feGaussianBlur stdDeviation={soften.toFixed(2)} /></filter>
      <filter id={`${id}-mottle`} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="7" />
        <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.6 0 0 0 -0.7" />
      </filter>
      <filter id={`${id}-grain`} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
    </defs>
    <g className="client-height-layer" role="img" aria-label="Sampled current-client elevation; exact replay build unverified" filter={`url(#${id}-soften)`}>
      {paths.map(({ band, path }) => <g key={band}>
        {band > 0 && <path className="height-shadow" d={path} transform={`translate(${shade.toFixed(2)},${(shade * 1.3).toFixed(2)})`} />}
        <path className="client-height-cell" d={path} fill={referenceHeightColor(band * 64)} data-height-band={band}>
          <title>{`${band * 64}–${(band + 1) * 64} world units · sampled height band, not an exact cliff or pathing boundary`}</title>
        </path>
      </g>)}
      <path className="height-contour minor" d={contours.minor} />
      <path className="height-contour major" d={contours.major} />
    </g>
    <rect className="terrain-mottle" x={clip.left} y={clip.top} width={clip.width} height={clip.height} filter={`url(#${id}-mottle)`} />
    <rect className="terrain-grain" x={clip.left} y={clip.top} width={clip.width} height={clip.height} filter={`url(#${id}-grain)`} />
    <g className="client-base-tree-layer" role="img" aria-label="Client base tree positions; current state unknown">
      {baseTrees.map((tree, index) => {
        const point = worldToScreen(bounds, tree.x, tree.y, viewport)!;
        const variation = treeVariation(tree.x, tree.y);
        return <g key={index} className="client-base-tree" transform={`translate(${point.x},${point.y})`}
          data-source-layer={tree.layer} aria-label="Base tree; current state unknown">
          <title>Base tree; current state unknown</title>
          <g transform={`scale(${(treeScale * variation.scale).toFixed(3)}) rotate(${variation.turn})`}>
            <ellipse className="reference-tree-shadow" cx="3" cy="5" rx="10" ry="7" />
            <path className="reference-tree-trunk" d="M0 2V7" />
            <path className={`reference-tree-canopy tone-${Math.floor(variation.tone * 3)}`} d="M0 -10C-6 -11 -10 -7 -9 -2C-11 3 -7 8 -1 7C5 9 10 5 9 0C11 -5 7 -11 0 -10Z" />
            <path className="reference-tree-highlight" d="M-5 -3Q-4 -8 1 -7" />
          </g>
        </g>;
      })}
    </g>
  </g>;
});
