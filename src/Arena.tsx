import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ClientMap } from '../shared/client-map';
import type { Frame, Hero, Scenario } from '../shared/scenario';
import { MapPortrait } from './assets';
import { arenaCamera, heroCallouts } from './camera';
import { ClientMapLayers, ClientMinimap } from './ClientMap';
import { percent, worldToScreen } from './game';
import { ObservedMapLayers } from './MapLayers';

function MapResource({ hero, kind, width }: { hero: Hero; kind: 'hp' | 'mana'; width: number }) {
  const value = hero[kind];
  const maximum = kind === 'hp' ? hero.maxHp : hero.maxMana;
  const ratio = percent(value, maximum);
  const y = kind === 'hp' ? 21 : 34;
  const height = kind === 'hp' ? 6 : 4;
  return <g className={`map-resource ${kind} ${ratio === null ? 'unknown' : ''}`}
    aria-label={`${kind === 'hp' ? 'HP' : 'Mana'} ${value ?? 'unknown'} / ${maximum ?? 'unknown'}`}>
    <rect className="map-resource-track" x="8" y={y} width={width - 48} height={height} rx="1" />
    {ratio !== null && <rect className="map-resource-fill" x="8" y={y} width={(width - 48) * ratio / 100} height={height} rx="1" />}
    {ratio === null && <text className="map-resource-unknown" x="12" y={y + height}>?</text>}
    <text className="map-resource-number" x={width - 7} y={y + height + 1} textAnchor="end">{value === null ? '?' : Math.round(value)}</text>
  </g>;
}

export function Arena({ scenario, frame, inspected, onInspect, clientMap, nowMs }: {
  scenario: Scenario; frame: Frame; inspected: string; onInspect: (id: string) => void;
  clientMap: ClientMap | null; nowMs: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const patternId = useId();
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const resize = () => setWidth(Math.round(node.getBoundingClientRect().width));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const camera = useMemo(() => arenaCamera(scenario.bounds, width), [scenario.bounds, width]);
  const { viewport, markerRadius: radius } = camera;
  const priority = (hero: Hero) => hero.id === inspected ? 2 : hero.alive === false ? 0 : 1;
  const markers = frame.heroes.flatMap(hero => {
    const point = worldToScreen(scenario.bounds, hero.x, hero.y, viewport);
    return point ? [{ hero, point }] : [];
  }).sort((a, b) => priority(a.hero) - priority(b.hero));
  const towers = (frame.towers ?? []).flatMap(tower => {
    const point = worldToScreen(scenario.bounds, tower.x, tower.y, viewport);
    return point && point.x >= viewport.left && point.x <= viewport.left + viewport.width
      && point.y >= viewport.top && point.y <= viewport.top + viewport.height
      ? [{ x: point.x - 17, y: point.y - 25, width: 34, height: 55 }] : [];
  });
  const callouts = heroCallouts([...markers].reverse().map(({ hero, point }) => ({ id: hero.id, name: hero.name, ...point })), camera, towers);
  const activate = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onInspect(id); }
  };
  const viewBox = `0 0 ${camera.width} ${camera.height}`;
  return <div className="arena" ref={element} data-camera-bounds={JSON.stringify(scenario.bounds)} data-camera-viewport={JSON.stringify(viewport)}>
    <svg className="arena-surface" viewBox={viewBox} role="group" aria-label="Terrain context">
      <defs>
        <pattern id={`${patternId}-grid`} width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke="#829195" strokeOpacity=".08" />
        </pattern>
      </defs>
      <rect width={camera.width} height={camera.height} fill="#111b1f" />
      <rect x={viewport.left} y={viewport.top} width={viewport.width} height={viewport.height} fill={`url(#${patternId}-grid)`} />
      <ClientMapLayers map={clientMap} scenario={scenario} nowMs={nowMs} viewport={viewport} />
    </svg>
    <ClientMinimap map={clientMap} scenario={scenario} frame={frame} nowMs={nowMs} size={camera.minimap.width} inset={camera.minimapInset} />
    <svg className="arena-actors" viewBox={viewBox} role="group" aria-label="Encounter map and recorded hero positions. Select a hero marker to inspect.">
      <ObservedMapLayers frame={frame} bounds={scenario.bounds} viewport={viewport} />
      {markers.map(({ hero, point }) => {
        const label = callouts.find(label => label.id === hero.id)!;
        return <line key={hero.id} className={`callout-leader ${hero.team} ${hero.id === inspected ? 'inspected' : ''}`}
          x1={point.x} y1={point.y} x2={label.leader.x} y2={label.leader.y} />;
      })}
      {markers.map(({ hero, point }) => <g key={hero.id} data-hero-id={hero.id} data-world-x={hero.x} data-world-y={hero.y}
        transform={`translate(${point.x},${point.y})`} role="button" tabIndex={0}
        aria-label={`Inspect ${hero.name}, hero level ${hero.level ?? 'unknown'}${hero.alive === false ? ', dead' : ''}`}
        aria-pressed={inspected === hero.id} className={`map-hero ${hero.team} ${hero.alive === false ? 'dead' : ''} ${inspected === hero.id ? 'inspected' : ''}`}
        onClick={() => onInspect(hero.id)} onKeyDown={event => activate(event, hero.id)}>
        <title>{`${hero.name} · hero level ${hero.level ?? 'unknown'} · ${hero.team} · ${hero.alive === null ? 'Alive state unknown' : hero.alive ? 'Alive' : 'Dead'}`}</title>
        <circle r={radius + 5} className="marker-halo" /><circle r={radius} className="marker-disc" />
        <g transform={`scale(${radius / 22})`}><MapPortrait hero={hero} /></g>
        <g className="map-hero-level" aria-hidden="true">
          <circle cx={radius * 0.72} cy={radius * 0.72} r="9" />
          <text x={radius * 0.72} y={radius * 0.72 + 3.5} textAnchor="middle">{hero.level ?? '?'}</text>
        </g>
      </g>)}
      {markers.map(({ hero }) => {
        const label = callouts.find(label => label.id === hero.id)!;
        return <g key={hero.id} className={`map-callout ${hero.team} ${hero.alive === false ? 'dead' : ''} ${hero.id === inspected ? 'inspected' : ''}`}
          data-hero-id={hero.id} transform={`translate(${label.x},${label.y})`} role="button" tabIndex={0}
          aria-label={`Inspect ${hero.name} details`} aria-pressed={hero.id === inspected}
          onClick={() => onInspect(hero.id)} onKeyDown={event => activate(event, hero.id)}>
          <title>{`${hero.name} · HP ${hero.hp ?? 'unknown'} / ${hero.maxHp ?? 'unknown'} · Mana ${hero.mana ?? 'unknown'} / ${hero.maxMana ?? 'unknown'}`}</title>
          <rect className="callout-panel" width={label.width} height={label.height} rx="4" />
          <text className="map-callout-name" x="8" y="14">{hero.name}</text>
          <MapResource hero={hero} kind="hp" width={label.width} />
          <MapResource hero={hero} kind="mana" width={label.width} />
        </g>;
      })}
    </svg>
  </div>;
}
