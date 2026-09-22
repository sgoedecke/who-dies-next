import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAbilityAsset, resolveHeroAsset, resolveItemAsset, type Asset, type AssetImage, type AssetManifest } from '../shared/assets.js';
import { catalogSchema, scenarioSchema, type Hero } from '../shared/scenario.js';
import { summarize, validatePng } from './fetch-assets.js';

type AssetKind = 'hero' | 'item' | 'ability';
export type AssetReference = { kind: AssetKind; id: string; name?: string; occurrences: number };
type ReferencedHero = Pick<Hero, 'id' | 'name' | 'items' | 'abilities'>;
export type AssetScenario = {
  frames: { heroes: ReferencedHero[] }[];
  startSnapshot: { heroes: ReferencedHero[] };
  question: { optionIds: string[]; answerId: string };
  events: { actorId: string | null; targetId: string | null; ability: string | null }[];
};
type Corpus = { catalogSha256: string; scenarios: { path: string; sha256: string }[] };
export type PublicAssetManifest = AssetManifest & {
  bundle: {
    kind: 'scenario-subset';
    sourceManifestSha256: string;
    corpus: Corpus;
    referenceOccurrences: number;
    distinctReferences: number;
    attribution: {
      artwork: string;
      metadata: string;
      notices: string;
      scope: string;
    };
  };
};
type FileTree = Map<string, Buffer>;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function collectAssetReferences(scenarios: readonly AssetScenario[]): AssetReference[] {
  const references = new Map<string, AssetReference>();
  function add(kind: AssetKind, id: string, name?: string) {
    const key = JSON.stringify([kind, id, name]);
    const existing = references.get(key);
    if (existing) existing.occurrences++;
    else references.set(key, { kind, id, ...(name === undefined ? {} : { name }), occurrences: 1 });
  }
  for (const scenario of scenarios) {
    for (const frame of [scenario.startSnapshot, ...scenario.frames]) {
      for (const hero of frame.heroes) {
        add('hero', hero.id, hero.name);
        for (const item of hero.items) add('item', item.name);
        for (const ability of hero.abilities) add('ability', ability.name);
      }
    }
    for (const id of [...scenario.question.optionIds, scenario.question.answerId]) add('hero', id);
    for (const event of scenario.events) {
      if (event.actorId) add('hero', event.actorId);
      if (event.targetId) add('hero', event.targetId);
      if (event.ability) {
        // Event labels try the ability resolver before the item resolver.
        add('ability', event.ability);
        add('item', event.ability);
      }
    }
  }
  return [...references.values()].sort((a, b) =>
    JSON.stringify([a.kind, a.id, a.name]).localeCompare(JSON.stringify([b.kind, b.id, b.name]), 'en'));
}

function resolveReference(manifest: AssetManifest, ref: AssetReference): Asset | null {
  if (ref.kind === 'hero') return resolveHeroAsset(manifest, ref.id, ref.name);
  if (ref.kind === 'item') return resolveItemAsset(manifest, ref.id);
  return resolveAbilityAsset(manifest, ref.id);
}

export function buildPublicManifest(
  source: AssetManifest, references: AssetReference[], corpus: Corpus, sourceManifestSha256: string,
): PublicAssetManifest {
  const groups: Record<AssetKind, Record<string, Asset>> = { hero: {}, item: {}, ability: {} };
  for (const ref of references) {
    const asset = resolveReference(source, ref);
    if (asset) groups[ref.kind][asset.name] = structuredClone(asset);
  }
  const sorted = (entries: Record<string, Asset>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, 'en')));
  const abilityNames = new Set(references.filter(ref => ref.kind === 'ability').map(ref => ref.id));
  const unsupported = source.unsupported.filter(entry => abilityNames.has(entry.name));
  const manifest: PublicAssetManifest = {
    schemaVersion: 1, generatedAt: source.generatedAt, sources: [...source.sources],
    heroes: sorted(groups.hero), items: sorted(groups.item), abilities: sorted(groups.ability),
    unsupported, missing: [], summary: structuredClone(source.summary),
    bundle: {
      kind: 'scenario-subset', sourceManifestSha256, corpus,
      referenceOccurrences: references.reduce((sum, ref) => sum + ref.occurrences, 0),
      distinctReferences: references.length,
      attribution: {
        artwork: 'Dota 2 artwork and names belong to Valve Corporation. Unofficial, not endorsed by Valve.',
        metadata: 'OpenDota dotaconstants; exact source revisions are listed in sources. No full metadata catalogs are distributed.',
        notices: '/THIRD_PARTY_NOTICES.md',
        scope: 'Only artwork referenced by the bundled replay snippets. Not a standalone asset pack. This packaging is not legal clearance.',
      },
    },
  };
  summarize(manifest);
  manifest.summary.cachedImages = imagePaths(manifest).size;
  manifest.summary.unsupportedAbilities = unsupported.length;
  for (const ref of references) {
    if (JSON.stringify(resolveReference(source, ref)) !== JSON.stringify(resolveReference(manifest, ref))) {
      throw new Error(`Pruning would change ${ref.kind} resolution for ${JSON.stringify(ref.id)}; ambiguous/unknown references must remain unchanged`);
    }
  }
  return manifest;
}

export function assetRelativePath(path: string): string {
  if (!/^\/assets\/(?:heroes\/(?:icons\/)?|items\/|abilities\/)[a-z0-9_]+\.png$/.test(path)) {
    throw new Error(`Asset path outside allowed public/assets image paths: ${path}`);
  }
  return path.slice('/assets/'.length);
}

export function imagePaths(manifest: AssetManifest): Map<string, AssetImage> {
  const paths = new Map<string, AssetImage>();
  const images = [
    ...Object.values(manifest.heroes).flatMap(hero => [hero, ...(hero.icon ? [hero.icon] : [])]),
    ...Object.values(manifest.items), ...Object.values(manifest.abilities),
  ];
  for (const image of images) {
    if (image.status === 'missing') {
      if (image.path !== null) throw new Error('Missing image must not have a local path');
      continue;
    }
    if (image.status !== 'downloaded' || !image.path || !/^[a-f0-9]{64}$/.test(image.sha256 ?? '')) {
      throw new Error('Downloaded image lacks a verified path/checksum');
    }
    const path = assetRelativePath(image.path);
    if (paths.has(path) && paths.get(path)!.sha256 !== image.sha256) throw new Error(`Conflicting image hashes: ${path}`);
    paths.set(path, image);
  }
  return paths;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function noSymlinks(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error('Filesystem path escapes its allowed root');
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const part of ['', ...parts]) {
    current = resolve(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function readTree(directory: string): Promise<FileTree> {
  const files: FileTree = new Map();
  async function walk(prefix: string) {
    const path = resolve(directory, prefix);
    if (!inside(directory, path)) throw new Error('Asset inventory path escapes its root');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(prefix ? `${prefix}/${name}` : name);
    } else if (stat.isFile()) {
      if (stat.size > 8 * 1024 * 1024) throw new Error(`Unexpected oversized asset file: ${prefix}`);
      files.set(prefix, await readFile(path));
    } else throw new Error(`Unsupported asset entry: ${path}`);
  }
  await walk('');
  return files;
}

function treeHash(tree: FileTree): string {
  return hash(JSON.stringify([...tree].map(([path, bytes]) => [path, hash(bytes)]).sort(([a], [b]) => a.localeCompare(b, 'en'))));
}

async function writeSafely(root: string, path: string, bytes: Buffer, exclusive = false): Promise<void> {
  await noSymlinks(root, path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: exclusive ? 'wx' : 'w' });
}

async function backupTree(root: string, tree: FileTree): Promise<string> {
  const backup = resolve(root, '.cache/asset-backups', treeHash(tree), 'assets');
  for (const [path, bytes] of tree) {
    const destination = resolve(backup, path);
    if (!inside(backup, destination)) throw new Error('Backup path escapes backup directory');
    await noSymlinks(root, destination);
    try {
      const previous = await readFile(destination);
      if (!previous.equals(bytes)) throw new Error(`Backup content mismatch: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeSafely(root, destination, bytes, true);
    }
  }
  if (treeHash(await readTree(backup)) !== treeHash(tree)) throw new Error('Backup verification failed; public assets unchanged');
  return backup;
}

async function loadCorpus(root: string): Promise<{ corpus: Corpus; scenarios: AssetScenario[] }> {
  const indexPath = resolve(root, 'public/scenarios/index.json');
  await noSymlinks(root, indexPath);
  const indexBytes = await readFile(indexPath);
  const catalog = catalogSchema.parse(JSON.parse(indexBytes.toString('utf8')));
  const scenarios: AssetScenario[] = [];
  const files: Corpus['scenarios'] = [];
  const seen = new Set<string>();
  for (const entry of catalog.scenarios) {
    if (!/^\/scenarios\/[a-zA-Z0-9_-]+\.json$/.test(entry.path)
      || entry.path !== `/scenarios/${entry.id}.json` || seen.has(entry.path)) {
      throw new Error(`Unsafe or duplicate scenario path: ${entry.path}`);
    }
    seen.add(entry.path);
    const path = resolve(root, `public${entry.path}`);
    await noSymlinks(root, path);
    const bytes = await readFile(path);
    const scenario = scenarioSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (scenario.id !== entry.id) throw new Error('Scenario ID does not match its catalog entry');
    scenarios.push(scenario);
    files.push({ path: entry.path, sha256: hash(bytes) });
  }
  return { corpus: { catalogSha256: hash(indexBytes), scenarios: files.sort((a, b) => a.path.localeCompare(b.path, 'en')) }, scenarios };
}

export async function preparePublicAssets(options: { root?: string; source?: string; check?: boolean } = {}) {
  const root = resolve(options.root ?? projectRoot);
  if (await realpath(root) !== root) throw new Error('Project root must not traverse symlinks');
  const destination = resolve(root, 'public/assets');
  const sourceDirectory = resolve(root, options.source ?? 'public/assets');
  if (sourceDirectory !== destination && !inside(resolve(root, '.cache'), sourceDirectory)) {
    throw new Error('Source must be public/assets or a private directory under .cache');
  }
  await noSymlinks(root, destination);
  await noSymlinks(root, sourceDirectory);
  await noSymlinks(root, resolve(root, '.cache'));
  await mkdir(resolve(root, '.cache'), { recursive: true });
  const lockPath = resolve(root, '.cache/prepare-public-assets.lock');
  const lock = await open(lockPath, 'wx');
  try {
    const current = await readTree(destination);
    const source = sourceDirectory === destination ? current : await readTree(sourceDirectory);
    const sourceBytes = source.get('manifest.json');
    if (!sourceBytes) throw new Error('Source has no asset manifest');
    const original = JSON.parse(sourceBytes.toString('utf8')) as AssetManifest & Partial<Pick<PublicAssetManifest, 'bundle'>>;
    if (original.schemaVersion !== 1) throw new Error('Unsupported asset manifest schema');
    const { corpus, scenarios } = await loadCorpus(root);
    const references = collectAssetReferences(scenarios);
    const manifest = buildPublicManifest(original, references, corpus, original.bundle?.sourceManifestSha256 ?? hash(sourceBytes));
    const expected: FileTree = new Map();
    for (const [path, image] of imagePaths(manifest)) {
      const bytes = source.get(path);
      if (!bytes) throw new Error(`Referenced image missing from source: ${path}`);
      validatePng(bytes);
      if (hash(bytes) !== image.sha256 || bytes.length !== image.bytes) throw new Error(`Referenced image checksum/size mismatch: ${path}`);
      expected.set(path, bytes);
    }
    expected.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const report = {
      scenarioCount: scenarios.length,
      referenceOccurrences: manifest.bundle.referenceOccurrences,
      distinctReferences: references.length,
      resolvedReferences: references.filter(ref => resolveReference(original, ref) !== null).length,
      unknownReferences: references.filter(ref => resolveReference(original, ref) === null),
      pngFiles: expected.size - 1,
      pngBytes: [...expected].filter(([path]) => path.endsWith('.png')).reduce((sum, [, bytes]) => sum + bytes.length, 0),
      summary: manifest.summary,
      sourceManifestSha256: manifest.bundle.sourceManifestSha256,
      outputTreeSha256: treeHash(expected),
      backup: null as string | null,
      checks: { identicalResolutions: true, identicalPngHashes: true, noUnreferencedFiles: true },
    };
    if (options.check) {
      if (treeHash(current) !== treeHash(expected)) throw new Error('Public assets differ from the exact referenced subset; run preparation first');
      return report;
    }
    const backup = await backupTree(root, current);
    report.backup = relative(root, backup);
    if (treeHash(await readTree(destination)) !== treeHash(current)) throw new Error('Public assets changed during preparation; refusing to overwrite');
    if (JSON.stringify((await loadCorpus(root)).corpus) !== JSON.stringify(corpus)) throw new Error('Scenario corpus changed during preparation; rerun required');
    for (const [path, bytes] of expected) {
      if (current.get(path)?.equals(bytes)) continue;
      const target = resolve(destination, path);
      const temporary = `${target}.${process.pid}.prepare`;
      try {
        await writeSafely(root, temporary, bytes, true);
        await noSymlinks(root, target);
        await rename(temporary, target);
      } finally {
        try { await unlink(temporary); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    for (const path of current.keys()) {
      if (expected.has(path)) continue;
      const target = resolve(destination, path);
      if (!inside(destination, target)) throw new Error('Deletion path escapes public/assets');
      await noSymlinks(root, target);
      await unlink(target);
    }
    if (treeHash(await readTree(destination)) !== treeHash(expected)) throw new Error('Prepared assets failed final exact-file verification');
    await writeSafely(root, resolve(root, '.cache/public-assets-report.json'), Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
    return report;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== '--');
  const sourceAt = args.indexOf('--source');
  const source = sourceAt >= 0 ? args[sourceAt + 1] : undefined;
  const allowed = new Set(['--check', '--source', ...(source ? [source] : [])]);
  if ((sourceAt >= 0 && (!source || source.startsWith('--'))) || args.some(arg => !allowed.has(arg))) {
    console.error('Usage: npm exec -- tsx scripts/prepare-public-assets.ts [--check] [--source .cache/.../assets]');
    process.exitCode = 1;
  } else {
    preparePublicAssets({ source, check: args.includes('--check') }).then(report => {
      const { unknownReferences, ...summary } = report;
      console.log(JSON.stringify({ ...summary, unknownReferences: unknownReferences.length }, null, 2));
    }).catch(error => {
      console.error(`Public asset preparation failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
