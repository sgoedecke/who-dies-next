import { createContext, useContext, useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { resolveAbilityAsset, resolveHeroAsset, resolveItemAsset } from '../shared/assets';
import type { AssetImage, AssetManifest } from '../shared/assets';
import type { Hero } from '../shared/scenario';
import { initials, readableAbilityName, readableName } from './game';
import { publicUrl } from './public-url';

const imageSchema = z.object({
  path: z.string().nullable(), url: z.string(), status: z.enum(['downloaded', 'missing']),
  sha256: z.string().optional(), bytes: z.number().optional(), error: z.string().optional(),
});
const assetSchema = imageSchema.extend({
  id: z.number().nullable(), name: z.string(), label: z.string(), aliases: z.array(z.string()),
  icon: imageSchema.optional(),
});
const countSchema = z.object({ total: z.number(), downloaded: z.number(), missing: z.number() });
const manifestSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string(), sources: z.array(z.string()),
  heroes: z.record(z.string(), assetSchema), items: z.record(z.string(), assetSchema),
  abilities: z.record(z.string(), assetSchema).default({}),
  summary: z.object({
    heroes: countSchema, heroIcons: countSchema, items: countSchema, uniqueImages: countSchema,
    cachedImages: z.number(), itemImageAliases: z.number(),
    abilities: countSchema.default({ total: 0, downloaded: 0, missing: 0 }), unsupportedAbilities: z.number().default(0),
  }),
  missing: z.array(z.object({
    kind: z.enum(['hero', 'heroIcon', 'item', 'ability']), name: z.string(), url: z.string(), error: z.string(),
  })),
  unsupported: z.array(z.object({ kind: z.literal('ability'), name: z.string(), reason: z.string() })).default([]),
});

export function parseAssetManifest(value: unknown): AssetManifest | null {
  const parsed = manifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Never fall back to CDN URLs: unavailable local art stays a text monogram. */
export function localImagePath(asset: AssetImage | null | undefined): string | null {
  if (asset?.status !== 'downloaded' || !asset.path) return null;
  if (!/^\/assets\/[a-zA-Z0-9_/-]+\.(png|jpg|jpeg|webp)$/i.test(asset.path)
    || asset.path.includes('//')) return null;
  return publicUrl(asset.path);
}

export const AssetContext = createContext<AssetManifest | null>(null);

export function displayHeroName(manifest: AssetManifest | null, hero: Pick<Hero, 'id' | 'name'>): string {
  return resolveHeroAsset(manifest, hero.id, hero.name)?.label ?? readableName(hero.name);
}

export function useAssetManifest(): AssetManifest | null {
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(publicUrl('/assets/manifest.json'), { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!controller.signal.aborted) setManifest(parseAssetManifest(data)); })
      .catch(() => { /* Local art is optional; text fallbacks keep the game playable. */ });
    return () => controller.abort();
  }, []);
  return manifest;
}

function LocalImage({ path, alt }: { path: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? null : <img src={path} alt={alt} width="48" height="48" draggable={false}
    style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', maxWidth: '100%', objectFit: 'cover', pointerEvents: 'none' }}
    onError={() => setFailed(true)} />;
}

export function HeroPortrait({ hero, large = false, size }: { hero: Pick<Hero, 'id' | 'name' | 'team'>; large?: boolean; size?: number }) {
  const manifest = useContext(AssetContext);
  const path = localImagePath(resolveHeroAsset(manifest, hero.id, hero.name));
  const label = displayHeroName(manifest, hero);
  return <span className={`hero-avatar portrait ${hero.team} ${large ? 'large' : ''}`}
    style={{ position: 'relative', overflow: 'hidden', width: size ?? (large ? 48 : 36), height: size ?? (large ? 48 : 36), flexShrink: 0 }}>
    <span aria-hidden="true">{initials(label)}</span>
    {path && <LocalImage key={path} path={path} alt={`${label} portrait`} />}
  </span>;
}

export function ItemArtwork({ name, slot = false }: { name: string; slot?: boolean }) {
  const manifest = useContext(AssetContext);
  const asset = resolveItemAsset(manifest, name);
  const path = localImagePath(asset);
  return <span className="item-artwork" style={{ position: 'relative', overflow: 'hidden', width: slot ? '100%' : 36, height: slot ? '100%' : 27, flexShrink: 0 }}><span aria-hidden="true">{initials(asset?.label ?? readableName(name))}</span>
    {path && <LocalImage key={path} path={path} alt={`${asset?.label ?? readableName(name)} item icon`} />}
  </span>;
}

export function ItemLabel({ name }: { name: string }) {
  const manifest = useContext(AssetContext);
  return resolveItemAsset(manifest, name)?.label ?? readableName(name);
}

export function AbilityLabel({ name, heroId }: { name: string; heroId: string }) {
  const manifest = useContext(AssetContext);
  return resolveAbilityAsset(manifest, name)?.label ?? readableAbilityName(name, heroId);
}

export function AbilityArtwork({ name, heroId }: { name: string; heroId: string }) {
  const manifest = useContext(AssetContext);
  const asset = resolveAbilityAsset(manifest, name);
  const label = asset?.label ?? readableAbilityName(name, heroId);
  const path = localImagePath(asset);
  return <span className="ability-artwork" style={{ position: 'relative', display: 'grid', placeItems: 'center', overflow: 'hidden', width: '100%', height: '100%' }}>
    <span aria-hidden="true">{initials(label)}</span>
    {path && <LocalImage key={path} path={path} alt={`${label} ability icon`} />}
  </span>;
}

function MapImage({ path, name }: { path: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const clipId = useId().replaceAll(':', '');
  if (failed) return null;
  return <>
    <defs><clipPath id={clipId}><circle r="20" /></clipPath></defs>
    <image href={path} x="-20" y="-20" width="40" height="40" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} onError={() => setFailed(true)} role="img" aria-label={`${name} portrait`} style={{ pointerEvents: 'none' }} />
  </>;
}

export function MapPortrait({ hero }: { hero: Hero }) {
  const manifest = useContext(AssetContext);
  const path = localImagePath(resolveHeroAsset(manifest, hero.id, hero.name));
  const label = displayHeroName(manifest, hero);
  return <>
    <text textAnchor="middle" y="5" className="marker-initial">{initials(label)}</text>
    {path && <MapImage key={path} path={path} name={label} />}
    {hero.alive === false && <><circle r="20" fill="#101519" fillOpacity=".65" /><text textAnchor="middle" y="8" className="marker-initial death-cross">×</text></>}
  </>;
}
