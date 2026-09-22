export interface AssetImage {
  path: string | null;
  url: string;
  status: 'downloaded' | 'missing';
  sha256?: string;
  bytes?: number;
  error?: string;
}

export interface Asset extends AssetImage {
  id: number | null;
  name: string;
  label: string;
  aliases: string[];
  icon?: AssetImage;
  imageAlias?: { name: string; reason: 'metadata-image'; source: string };
}

export interface AssetCount {
  total: number;
  downloaded: number;
  missing: number;
}

export interface AssetManifest {
  schemaVersion: 1;
  generatedAt: string;
  sources: string[];
  heroes: Record<string, Asset>;
  items: Record<string, Asset>;
  abilities: Record<string, Asset>;
  summary: {
    heroes: AssetCount;
    heroIcons: AssetCount;
    items: AssetCount;
    abilities: AssetCount;
    uniqueImages: AssetCount;
    cachedImages: number;
    itemImageAliases: number;
    unsupportedAbilities: number;
  };
  missing: Array<{ kind: 'hero' | 'heroIcon' | 'item' | 'ability'; name: string; url: string; error: string }>;
  unsupported: Array<{ kind: 'ability'; name: string; reason: string }>;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolve(entries: Record<string, Asset>, value: string, prefix: string): Asset | null {
  if (!value.trim()) return null;
  const lower = value.trim().toLowerCase();
  if (Object.hasOwn(entries, lower)) return entries[lower];
  if (Object.hasOwn(entries, prefix + lower)) return entries[prefix + lower];
  const key = normalize(lower);
  const matches = Object.values(entries).filter(asset =>
    (asset.id !== null && String(asset.id) === lower)
    || [asset.name, asset.label, ...asset.aliases].some(alias => normalize(alias) === key));
  // Ambiguous human labels must never silently resolve to a different variant.
  return matches.length === 1 ? matches[0] : null;
}

export function resolveHeroAsset(manifest: AssetManifest | null, id: string, name?: string): Asset | null {
  if (!manifest) return null;
  return resolve(manifest.heroes, id, 'npc_dota_hero_')
    ?? (name ? resolve(manifest.heroes, name, 'npc_dota_hero_') : null);
}

export function resolveItemAsset(manifest: AssetManifest | null, name: string): Asset | null {
  return manifest ? resolve(manifest.items, name, 'item_') : null;
}

export function resolveAbilityAsset(manifest: AssetManifest | null, name: string): Asset | null {
  return manifest ? resolve(manifest.abilities ?? {}, name, '') : null;
}
