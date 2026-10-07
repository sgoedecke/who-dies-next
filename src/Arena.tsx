import { useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ClientMap } from '../shared/client-map';
import type { Frame, Hero, Scenario } from '../shared/scenario';
import { resolveAbilityAsset, resolveItemAsset } from '../shared/assets';
import { AssetContext, localImagePath, MapPortrait } from './assets';
import { arenaCamera, heroCallouts, surfaceExtent } from './camera';
import { ClientMapLayers, ClientMinimap } from './ClientMap';
import { casts, damagePopups, deathBursts, hitFlashes, strikes, trails } from './fx';
import { percent, worldToScreen } from './game';
import { ObservedMapLayers } from './MapLayers';

/** Health severity, independent of team colour. */
export function healthTone(ratio: number | null): '' | 'healthy' | 'hurt' | 'critical' {
  if (ratio === null) return '';
  return ratio > 50 ? 'healthy' : ratio > 25 ? 'hurt' : 'critical';
}

function MapResource({ hero, kind, width }: { hero: Hero; kind: 'hp' | 'mana'; width: number }) {
  const value = hero[kind];
  const maximum = kind === 'hp' ? hero.maxHp : hero.maxMana;
  const ratio = percent(value, maximum);
  const y = kind === 'hp' ? 21 : 34;
  const height = kind === 'hp' ? 6 : 4;
  return <g className={`map-resource ${kind} ${ratio === null ? 'unknown' : ''} ${kind === 'hp' ? healthTone(ratio) : ''}`}
    aria-label={`${kind === 'hp' ? 'HP' : 'Mana'} ${value ?? 'unknown'} / ${maximum ?? 'unknown'}`}>
    <rect className="map-resource-track" x="8" y={y} width={width - 48} height={height} rx="1" />
    {ratio !== null && <rect className="map-resource-fill" x="8" y={y} width={(width - 48) * ratio / 100} height={height} rx="1" />}
    {ratio === null && <text className="map-resource-unknown" x="12" y={y + height}>?</text>}
    <text className="map-resource-number" x={width - 7} y={y + height + 1} textAnchor="end">{value === null ? '?' : Math.round(value)}</text>
  </g>;
}

function CastBadge({ ability, x, y, age }: { ability: string; x: number; y: number; age: number }) {
  const manifest = useContext(AssetContext);
  const clipId = useId().replaceAll(':', '');
  const path = localImagePath(resolveAbilityAsset(manifest, ability) ?? resolveItemAsset(manifest, ability));
  if (!path) return null;
  const pop = Math.min(1, age / 0.12);
  const opacity = age > 0.9 ? Math.max(0, 1 - (age - 0.9) / 0.3) : 1;
  return <g className="fx-cast-badge" transform={`translate(${x},${y - age * 6}) scale(${0.6 + pop * 0.4})`} opacity={opacity}>
    <defs><clipPath id={clipId}><rect x="-12" y="-12" width="24" height="24" rx="4" /></clipPath></defs>
    <rect x="-13.5" y="-13.5" width="27" height="27" rx="5" className="fx-cast-frame" />
    <image href={path} x="-12" y="-12" width="24" height="24" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
  </g>;
}

export function Arena({ scenario, frame, inspected, onInspect, clientMap, nowMs, time = null }: {
  scenario: Scenario; frame: Frame; inspected: string; onInspect: (id: string) => void;
  clientMap: ClientMap | null; nowMs: number;
  /** Continuation time once the guess is locked; recorded-event effects are hidden before then. */
  time?: number | null;
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
  // Context terrain fills the whole surface (with a bleed for soft edges) under the same transform.
  const terrain = useMemo(() => surfaceExtent(scenario.bounds, camera, 48), [scenario.bounds, camera]);
  const surface = useMemo(() => ({ left: 0, top: 0, width: camera.width, height: camera.height }), [camera]);
  const participants = useMemo(() => new Set(scenario.startSnapshot.heroes.map(hero => hero.id)), [scenario]);
  const teamOf = (id: string) => frame.heroes.find(hero => hero.id === id)?.team ?? 'radiant';
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
  const pointOf = (id: string) => markers.find(marker => marker.hero.id === id)?.point;
  const effects = time === null ? null : {
    trails: [...trails(scenario, time)].flatMap(([id, points]) => {
      const screen = points.flatMap(point => worldToScreen(scenario.bounds, point.x, point.y, viewport) ?? []);
      return screen.length > 1 ? [{ id, screen }] : [];
    }),
    strikes: strikes(scenario.events, participants, time),
    flashes: hitFlashes(scenario.events, participants, time),
    casts: casts(scenario.events, participants, time),
    deaths: deathBursts(scenario.events, participants, time),
    popups: damagePopups(scenario.events, participants, time),
  };
  const activate = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onInspect(id); }
  };
  const viewBox = `0 0 ${camera.width} ${camera.height}`;
  return <div className="arena" ref={element} data-camera-bounds={JSON.stringify(scenario.bounds)} data-camera-viewport={JSON.stringify(viewport)}
    data-terrain-bounds={JSON.stringify(terrain.bounds)}>
    <svg className="arena-surface" viewBox={viewBox} role="group" aria-label="Terrain context">
      <defs>
        <pattern id={`${patternId}-grid`} width="32" height="32" patternUnits="userSpaceOnUse">
          <path d="M32 0H0V32" fill="none" stroke="#829195" strokeOpacity=".08" />
        </pattern>
        <radialGradient id={`${patternId}-vignette`} cx="50%" cy="50%" r="75%">
          <stop offset="55%" stopColor="#0a1114" stopOpacity="0" />
          <stop offset="100%" stopColor="#0a1114" stopOpacity=".6" />
        </radialGradient>
      </defs>
      <rect width={camera.width} height={camera.height} fill="#111b1f" />
      <rect width={camera.width} height={camera.height} fill={`url(#${patternId}-grid)`} />
      <ClientMapLayers map={clientMap} scenario={scenario} nowMs={nowMs} viewport={terrain.viewport} bounds={terrain.bounds} clip={surface} />
      <rect className="arena-vignette" width={camera.width} height={camera.height} fill={`url(#${patternId}-vignette)`} />
    </svg>
    <ClientMinimap map={clientMap} scenario={scenario} frame={frame} nowMs={nowMs} size={camera.minimap.width} inset={camera.minimapInset} />
    <svg className="arena-actors" viewBox={viewBox} role="group" aria-label="Encounter map and recorded hero positions. Select a hero marker to inspect.">
      <ObservedMapLayers frame={frame} bounds={scenario.bounds} viewport={viewport} />
      {effects && <g className="fx-under" aria-hidden="true">
        {effects.trails.map(({ id, screen }) => <g key={id} className={`fx-trail ${teamOf(id)}`}>
          {screen.slice(1).map((point, index) => <line key={index} x1={screen[index].x} y1={screen[index].y} x2={point.x} y2={point.y}
            strokeOpacity={0.55 * (1 - index / screen.length)} />)}
        </g>)}
        {effects.strikes.map(strike => {
          const from = pointOf(strike.actorId), to = pointOf(strike.targetId);
          if (!from || !to) return null;
          const distance = Math.hypot(to.x - from.x, to.y - from.y);
          if (distance < radius * 2) return null;
          const ux = (to.x - from.x) / distance, uy = (to.y - from.y) / distance;
          const fade = 1 - strike.age / 0.5;
          return <g key={strike.key} className={`fx-strike ${teamOf(strike.actorId)} ${strike.spell ? 'spell' : 'attack'}`} opacity={fade}>
            <line x1={from.x + ux * radius} y1={from.y + uy * radius} x2={to.x - ux * radius} y2={to.y - uy * radius} />
            <circle cx={to.x - ux * radius} cy={to.y - uy * radius} r={strike.spell ? 5 : 3.5} />
          </g>;
        })}
      </g>}
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
      {effects && <g className="fx-over" aria-hidden="true">
        {[...effects.flashes].map(([id, intensity]) => {
          const point = pointOf(id);
          return point && <circle key={id} className="fx-hit" cx={point.x} cy={point.y} r={radius} opacity={0.55 * intensity} />;
        })}
        {effects.casts.map(cast => {
          const point = pointOf(cast.actorId);
          if (!point) return null;
          return <g key={cast.actorId}>
            <circle className={`fx-cast-ring ${teamOf(cast.actorId)}`} cx={point.x} cy={point.y} r={radius + 4 + cast.age * 26} opacity={Math.max(0, 1 - cast.age / 0.8)} />
            <CastBadge ability={cast.ability} x={point.x + radius * 0.85} y={point.y - radius * 0.95} age={cast.age} />
          </g>;
        })}
        {effects.deaths.map(death => {
          const point = pointOf(death.targetId);
          if (!point) return null;
          const fade = Math.max(0, 1 - death.age / 1.6);
          return <g key={death.targetId} className="fx-death" opacity={fade}>
            <circle cx={point.x} cy={point.y} r={radius * (1 + death.age * 1.4)} />
            <circle cx={point.x} cy={point.y} r={radius * (1 + death.age * 0.7)} className="inner" />
          </g>;
        })}
      </g>}
      {markers.map(({ hero }) => {
        const label = callouts.find(label => label.id === hero.id)!;
        return <g key={hero.id} className={`map-callout ${hero.team} ${hero.alive === false ? 'dead' : ''} ${hero.id === inspected ? 'inspected' : ''}`}
          data-hero-id={hero.id} transform={`translate(${label.x},${label.y})`} role="button" tabIndex={0}
          aria-label={`Inspect ${hero.name} details`} aria-pressed={hero.id === inspected}
          onClick={() => onInspect(hero.id)} onKeyDown={event => activate(event, hero.id)}>
          <title>{`${hero.name} · HP ${hero.hp ?? 'unknown'} / ${hero.maxHp ?? 'unknown'} · Mana ${hero.mana ?? 'unknown'} / ${hero.maxMana ?? 'unknown'}`}</title>
          <rect className="callout-panel" width={label.width} height={label.height} rx="4" />
          <rect className="callout-team" x="0.5" y="4" width="3" height={label.height - 8} rx="1.5" />
          <text className="map-callout-name" x="8" y="14">{hero.name}</text>
          <MapResource hero={hero} kind="hp" width={label.width} />
          <MapResource hero={hero} kind="mana" width={label.width} />
        </g>;
      })}
      {effects && <g className="fx-popups" aria-hidden="true">
        {effects.popups.map(popup => {
          const point = pointOf(popup.targetId);
          if (!point) return null;
          const rise = popup.age * 30;
          const opacity = Math.max(0, 1 - (popup.age / 0.9) ** 2);
          // Alternate sides per bucket so consecutive hits don't stack on one spot.
          const side = popup.slot % 2 === 0 ? 1 : -1;
          return <text key={popup.key} className={`fx-damage ${popup.spell ? 'spell' : 'attack'}`} textAnchor="middle" opacity={opacity}
            x={point.x + side * (radius + 10 + popup.age * 8) * (popup.spell ? -1 : 1)} y={point.y - radius * 0.4 - rise}>{Math.round(popup.amount)}</text>;
        })}
      </g>}
    </svg>
  </div>;
}
