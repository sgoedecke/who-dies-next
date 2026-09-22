import type { Frame, Scenario } from '../shared/scenario';
import { MAP_VIEWPORT, percent, readableName, worldToScreen } from './game';
import type { MapViewport } from './game';

export function ObservedMapLayers({ frame, bounds, viewport = MAP_VIEWPORT }: { frame: Frame; bounds: Scenario['bounds']; viewport?: MapViewport }) {
  const inBounds = (x: number | null, y: number | null) => x !== null && y !== null
    && x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  return <g className="observed-map-layers">
    <g aria-label="Observed tree layer">
      {(frame.trees ?? []).map(tree => {
        const point = worldToScreen(bounds, tree.x, tree.y, viewport);
        if (!point) return null;
        const state = tree.alive === null ? 'state unknown' : tree.alive ? 'alive' : 'destroyed';
        return <g key={tree.id} transform={`translate(${point.x},${point.y})`} className={`map-tree ${tree.alive === false ? 'destroyed' : tree.alive === null ? 'unknown-state' : ''}`}
          role="img" aria-label={`Observed tree ${tree.id}, ${state}`} data-map-entity={tree.id}
          display={inBounds(tree.x, tree.y) ? undefined : 'none'}>
          <title>{`Observed tree · ${state} · world ${Math.round(tree.x!)}, ${Math.round(tree.y!)}`}</title>
          {tree.alive === false ? <path d="M-4 3 L4 -3 M-4 -3 L4 3" className="tree-stump" />
            : <><path d="M0 2 V7" className="tree-trunk" /><path d="M0 -8 L6 3 H-6 Z" className="tree-canopy" /></>}
        </g>;
      })}
    </g>
    <g aria-label="Observed tower layer">
      {(frame.towers ?? []).map(tower => {
        const point = worldToScreen(bounds, tower.x, tower.y, viewport);
        if (!point) return null;
        const hp = percent(tower.hp, tower.maxHp);
        const state = tower.alive === null ? 'state unknown' : tower.alive ? 'alive' : 'destroyed';
        const label = readableName(tower.name.replace(/^npc_dota_/, ''));
        return <g key={tower.id} transform={`translate(${point.x},${point.y})`} className={`map-tower ${tower.team} ${tower.alive === false ? 'destroyed' : tower.alive === null ? 'unknown-state' : ''}`}
          role="img" aria-label={`${tower.team} tower ${label}, ${state}, HP ${tower.hp ?? 'unknown'}`} data-map-entity={tower.id}
          display={inBounds(tower.x, tower.y) ? undefined : 'none'}>
          <title>{`${label} · ${tower.team} · ${state} · HP ${tower.hp ?? 'unknown'} / ${tower.maxHp ?? 'unknown'}`}</title>
          <rect x="-13" y="-15" width="26" height="29" rx="3" className="tower-plinth" />
          <path d="M-8 -10 H-4 V-6 H-1 V-10 H3 V-6 H6 V-10 H9 V-2 H6 V10 H-6 V-2 H-8 Z" className="tower-body" />
          {tower.alive === false && <path d="M-12 -12 L12 12 M-12 12 L12 -12" className="tower-destroyed-cross" />}
          <rect x="-15" y="-23" width="30" height="3" rx="1" fill="#253038" />
          {hp !== null && <rect x="-15" y="-23" width={30 * hp / 100} height="3" rx="1" className="marker-health" />}
          <text textAnchor="middle" y="26" className="tower-label">{tower.hp ?? '?'}</text>
        </g>;
      })}
    </g>
  </g>;
}
