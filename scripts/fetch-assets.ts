import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Asset, AssetImage, AssetManifest } from '../shared/assets.js';

const CDN = 'https://cdn.cloudflare.steamstatic.com';
const IMAGE_ROOT = '/apps/dota2/images/dota_react/';
const CONCURRENCY = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const RETRIES = 2;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Fetch = typeof fetch;
type HeroMetadata = { id: number; name: string; localized_name: string; img?: string; icon?: string };
type ItemMetadata = { id?: number; dname?: string; img?: string };
export type Catalogs = {
  heroes: Record<string, HeroMetadata>;
  items: Record<string, ItemMetadata>;
  itemIds: Record<string, string>;
  heroAbilities?: Record<string, { abilities: string[]; talents?: { name: string }[] }>;
  abilities?: Record<string, { dname?: string; img?: string }>;
  abilityIds?: Record<string, string>;
};

class DownloadError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

export function validatePng(bytes: Uint8Array): void {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_MAGIC)
    || buffer.toString('ascii', 12, 16) !== 'IHDR'
    || buffer.readUInt32BE(16) === 0 || buffer.readUInt32BE(20) === 0
    || buffer.toString('ascii', buffer.length - 8, buffer.length - 4) !== 'IEND') {
    throw new DownloadError('Invalid or truncated PNG');
  }
}

async function requestBytes(
  url: string, maxBytes: number, png: boolean, fetcher: Fetch = fetch,
  timeoutMs = TIMEOUT_MS, retries = RETRIES,
): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        signal: controller.signal, redirect: 'error',
        headers: { 'User-Agent': 'dotadle-local-assets/1.0', Accept: png ? 'image/png' : 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadError(`HTTP ${response.status}`, response.status === 429 || response.status >= 500);
      }
      if (png && !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new DownloadError(`Expected image/png, received ${response.headers.get('content-type') ?? 'no content type'}`);
      }
      const length = Number(response.headers.get('content-length'));
      if (length > maxBytes) {
        await response.body?.cancel();
        throw new DownloadError(`Response exceeds ${maxBytes} byte limit`);
      }
      if (!response.body) throw new DownloadError('Empty response body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new DownloadError(`Response exceeds ${maxBytes} byte limit`);
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      if (png) validatePng(bytes);
      return bytes;
    } catch (error) {
      if (attempt >= retries || (error instanceof DownloadError && !error.retryable)) throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise(done => setTimeout(done, 250 * 2 ** attempt));
  }
}

export async function fetchPng(
  url: string, fetcher: Fetch = fetch, limits: { maxBytes?: number; timeoutMs?: number; retries?: number } = {},
): Promise<Buffer> {
  validateImageUrl(url);
  return requestBytes(url, limits.maxBytes ?? MAX_IMAGE_BYTES, true, fetcher, limits.timeoutMs, limits.retries);
}

function validateImageUrl(value: string): URL {
  const url = new URL(value, CDN);
  if (url.origin !== CDN || !url.pathname.startsWith(IMAGE_ROOT)
    || !/^\/apps\/dota2\/images\/dota_react\/(?:heroes\/(?:icons\/)?|items\/|abilities\/)[a-z0-9_]+\.png$/.test(url.pathname)) {
    throw new Error(`Unapproved image URL: ${value}`);
  }
  return url;
}

function image(metadataUrl: string | undefined, kind: string, name: string): AssetImage {
  const url = validateImageUrl(metadataUrl ?? `${CDN}${IMAGE_ROOT}${kind}/${name}.png`);
  // Query strings only contain cache busters; use a stable URL for cache identity.
  url.search = '';
  return { path: null, url: url.href, status: 'missing' };
}

export function buildManifest(catalogs: Catalogs, sources: string[]): AssetManifest {
  const heroes: Record<string, Asset> = {};
  const items: Record<string, Asset> = {};
  const abilities: Record<string, Asset> = {};
  const unsupported: AssetManifest['unsupported'] = [];
  for (const hero of Object.values(catalogs.heroes)) {
    if (!Number.isInteger(hero.id) || !/^npc_dota_hero_[a-z0-9_]+$/.test(hero.name)) throw new Error('Invalid hero metadata');
    const internal = hero.name.replace(/^npc_dota_hero_/, '');
    heroes[hero.name] = {
      id: hero.id, name: hero.name, label: hero.localized_name,
      aliases: [internal, hero.localized_name.toLowerCase()],
      ...image(hero.img, 'heroes', internal), icon: image(hero.icon, 'heroes/icons', internal),
    };
  }
  const ids = new Map<string, number>();
  for (const [id, name] of Object.entries(catalogs.itemIds)) {
    if (!/^\d+$/.test(id) || !/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid item ID metadata');
    if (ids.has(name)) throw new Error(`Conflicting item IDs for ${name}`);
    ids.set(name, Number(id));
  }
  for (const internal of [...new Set([...Object.keys(catalogs.items), ...ids.keys()])].sort()) {
    if (!/^[a-z0-9_]+$/.test(internal)) throw new Error(`Invalid item name: ${internal}`);
    const metadata = catalogs.items[internal];
    const id = ids.get(internal) ?? metadata?.id ?? null;
    if (metadata?.id !== undefined && id !== metadata.id) throw new Error(`Conflicting ID for ${internal}`);
    const label = metadata?.dname || internal.replaceAll('_', ' ');
    const asset: Asset = {
      id, name: `item_${internal}`, label, aliases: [internal, label.toLowerCase()],
      ...image(metadata?.img, 'items', internal),
    };
    const imageName = new URL(asset.url).pathname.split('/').at(-1)!.replace(/\.png$/, '');
    if (imageName !== internal) {
      asset.imageAlias = { name: `item_${imageName}`, reason: 'metadata-image', source: sources[1] };
    }
    items[asset.name] = asset;
  }
  const abilityIds = new Map<string, number[]>();
  for (const [id, name] of Object.entries(catalogs.abilityIds ?? {})) {
    if (!/^\d+(?:,\d+)*$/.test(id) || !/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid ability ID metadata');
    if (abilityIds.has(name)) throw new Error(`Conflicting ability IDs for ${name}`);
    abilityIds.set(name, id.split(',').map(Number));
  }
  const abilityNames = new Set([
    ...Object.keys(catalogs.abilities ?? {}), ...abilityIds.keys(),
    ...Object.values(catalogs.heroAbilities ?? {}).flatMap(hero => [
      ...hero.abilities, ...(hero.talents ?? []).map(talent => talent.name),
    ]),
  ]);
  for (const name of [...abilityNames].sort()) {
    if (name.startsWith('special_bonus')) {
      unsupported.push({ kind: 'ability', name, reason: 'Talent/stat bonus: no unique ability icon promised by metadata; not downloaded.' });
      continue;
    }
    if (!/^[a-z0-9_]+$/.test(name)) {
      unsupported.push({ kind: 'ability', name, reason: 'Metadata key is not a canonical lowercase ability internal name; not downloaded.' });
      continue;
    }
    const metadata = catalogs.abilities?.[name];
    const label = metadata?.dname || name.replaceAll('_', ' ');
    const definitionIds = abilityIds.get(name) ?? [];
    const asset: Asset = {
      id: definitionIds.length === 1 ? definitionIds[0] : null, name, label,
      aliases: [name, label.toLowerCase(), ...definitionIds.map(String)],
      ...image(metadata?.img, 'abilities', name),
    };
    const imageName = new URL(asset.url).pathname.split('/').at(-1)!.replace(/\.png$/, '');
    if (imageName !== name) {
      asset.imageAlias = { name: imageName, reason: 'metadata-image', source: sources[4] };
    }
    abilities[name] = asset;
  }
  const manifest: AssetManifest = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), sources, heroes, items, abilities, unsupported,
    summary: {
      heroes: { total: 0, downloaded: 0, missing: 0 }, heroIcons: { total: 0, downloaded: 0, missing: 0 },
      items: { total: 0, downloaded: 0, missing: 0 }, uniqueImages: { total: 0, downloaded: 0, missing: 0 },
      abilities: { total: 0, downloaded: 0, missing: 0 },
      cachedImages: 0, itemImageAliases: 0, unsupportedAbilities: unsupported.length,
    },
    missing: [],
  };
  summarize(manifest);
  return manifest;
}

function entries(manifest: AssetManifest): Array<{ kind: 'hero' | 'heroIcon' | 'item' | 'ability'; name: string; image: AssetImage }> {
  return [
    ...Object.values(manifest.heroes).flatMap(asset => [
      { kind: 'hero' as const, name: asset.name, image: asset },
      ...(asset.icon ? [{ kind: 'heroIcon' as const, name: asset.name, image: asset.icon }] : []),
    ]),
    ...Object.values(manifest.items).map(asset => ({ kind: 'item' as const, name: asset.name, image: asset })),
    ...Object.values(manifest.abilities ?? {}).map(asset => ({ kind: 'ability' as const, name: asset.name, image: asset })),
  ];
}

export function summarize(manifest: AssetManifest): void {
  const all = entries(manifest);
  const count = (images: AssetImage[]) => ({
    total: images.length, downloaded: images.filter(asset => asset.status === 'downloaded').length,
    missing: images.filter(asset => asset.status === 'missing').length,
  });
  manifest.summary.heroes = count(Object.values(manifest.heroes));
  manifest.summary.heroIcons = count(Object.values(manifest.heroes).flatMap(asset => asset.icon ? [asset.icon] : []));
  manifest.summary.items = count(Object.values(manifest.items));
  manifest.summary.abilities = count(Object.values(manifest.abilities));
  manifest.summary.uniqueImages = count([...new Map(all.map(entry => [entry.image.url, entry.image])).values()]);
  manifest.summary.itemImageAliases = Object.values(manifest.items).filter(asset => asset.imageAlias).length;
  manifest.missing = all.filter(({ image }) => image.status === 'missing').map(({ kind, name, image }) => ({
    kind, name, url: image.url, error: image.error ?? 'Not downloaded',
  }));
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  try {
    await writeFile(partial, data);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache/asset-catalog');
  const commitUrl = 'https://api.github.com/repos/odota/dotaconstants/commits/master';
  const commit = JSON.parse((await requestBytes(commitUrl, MAX_METADATA_BYTES, false)).toString()) as { sha?: string };
  if (!commit.sha || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Cannot identify metadata revision');
  const catalogFiles = ['heroes', 'items', 'item_ids', 'hero_abilities', 'abilities', 'ability_ids'];
  const sources = catalogFiles.map(name =>
    `https://raw.githubusercontent.com/odota/dotaconstants/${commit.sha}/build/${name}.json`);
  const raw = await Promise.all(sources.map(url => requestBytes(url, MAX_METADATA_BYTES, false)));
  const catalogs: Catalogs = {
    heroes: JSON.parse(raw[0].toString()), items: JSON.parse(raw[1].toString()), itemIds: JSON.parse(raw[2].toString()),
    heroAbilities: JSON.parse(raw[3].toString()), abilities: JSON.parse(raw[4].toString()), abilityIds: JSON.parse(raw[5].toString()),
  };
  if (Object.keys(catalogs.heroes).length < 100 || Object.keys(catalogs.items).length < 200
    || Object.keys(catalogs.itemIds).length < Object.keys(catalogs.items).length
    || Object.keys(catalogs.heroAbilities!).length < 100 || Object.keys(catalogs.abilities!).length < 500
    || Object.keys(catalogs.abilityIds!).length < 500) {
    throw new Error('Metadata catalog is unexpectedly incomplete; existing assets left intact');
  }
  const manifest = buildManifest(catalogs, [...sources, CDN]);
  const manifestFile = resolve(root, 'assets/manifest.json');
  let previous: AssetManifest | null = null;
  try {
    previous = JSON.parse(await readFile(manifestFile, 'utf8')) as AssetManifest;
    if (previous?.schemaVersion !== 1) previous = null;
  } catch { /* A first run or invalid manifest forces full verification/download. */ }
  const cached = new Map(previous ? entries(previous).map(entry => [entry.image.url, entry.image]) : []);
  const jobs = [...new Set(entries(manifest).map(entry => entry.image.url))];
  const results = new Map<string, AssetImage>();
  let next = 0;
  let finished = 0;
  console.log(`Catalog ${commit.sha}: ${Object.keys(manifest.heroes).length} heroes (portraits + icons), ${Object.keys(manifest.items).length} items, ${Object.keys(manifest.abilities).length} abilities; ${jobs.length} unique images.`);
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const url = jobs[next++];
      if (!url) return;
      const path = `/assets/${new URL(url).pathname.slice(IMAGE_ROOT.length)}`;
      const diskPath = resolve(root, `.${path}`);
      try {
        let bytes: Buffer | null = null;
        const prior = cached.get(url);
        if (prior?.status === 'downloaded' && prior.sha256 && prior.path === path) {
          try {
            const local = await readFile(diskPath);
            if (local.length > MAX_IMAGE_BYTES) throw new Error('Cached image too large');
            validatePng(local);
            if (createHash('sha256').update(local).digest('hex') !== prior.sha256) throw new Error('Checksum mismatch');
            bytes = local;
            manifest.summary.cachedImages++;
          } catch { /* Corrupt or absent files are fetched again. */ }
        }
        if (!bytes) {
          bytes = await fetchPng(url);
          await atomicWrite(diskPath, bytes);
        }
        results.set(url, {
          path, url, status: 'downloaded', bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } catch (error) {
        results.set(url, { path: null, url, status: 'missing', error: error instanceof Error ? error.message : String(error) });
      }
      finished++;
      if (finished % 100 === 0 || finished === jobs.length) console.log(`Verified ${finished}/${jobs.length} image requests.`);
    }
  }));
  for (const entry of entries(manifest)) Object.assign(entry.image, results.get(entry.image.url));
  summarize(manifest);
  manifest.generatedAt = new Date().toISOString();
  await Promise.all(raw.map((bytes, index) => atomicWrite(resolve(root, `assets/catalog/${catalogFiles[index]}.json`), bytes)));
  await atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest.summary, null, 2));
  console.log(`Manifest: ${manifestFile}; ${manifest.missing.length} missing entries (see manifest.missing for exact URLs/errors).`);
  if (manifest.missing.length) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Asset refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
