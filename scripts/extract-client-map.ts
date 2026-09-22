import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { clientMapSchema, type ClientMap } from '../shared/client-map.js';
import { catalogSchema, rawReplaySchema, scenarioSchema } from '../shared/scenario.js';
import { assertRecentMatch } from '../shared/recent.js';
import { decodeEntityDump, decodeHeightGrid, encodeHeightRows, sampleHeight, type MapEntity } from '../ingestion/client-map.js';
import { MAP_DEPOT, MAP_MANIFEST, selectCurrentMapFiles } from '../ingestion/map-assets.js';
import { atomicJson } from '../ingestion/files.js';
import { worldCollisionSampler } from '../ingestion/collision-check.js';

const root = resolve('.cache/terrain');
const client = join(root, 'current-client');
const extracted = join(root, 'derived-inputs');
const tool = resolve('.tools/source2-viewer/Source2Viewer-CLI');
const archive = join(client, 'game/dota/maps/dota.vpk');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifest = await readFile(join(root, 'authenticated-manifest', `manifest_${MAP_DEPOT}_${MAP_MANIFEST}.txt`), 'utf8');
for (const file of selectCurrentMapFiles(manifest)) {
  const path = join(client, file.path);
  if ((await stat(path)).size !== file.size) throw new Error(`Client asset size mismatch: ${file.path}`);
  if (createHash('sha1').update(await readFile(path)).digest('hex') !== file.sha1) throw new Error(`Client manifest hash mismatch: ${file.path}`);
}
const archiveHash = sha256(await readFile(archive));
if (archiveHash !== '39aef5c803e8b936646f5f77c6b540c11cb848a6fba7bd7ceebd13b6e2b0705d') {
  throw new Error('This extraction implementation is verified only for the recorded current map archive');
}
await mkdir(extracted, { recursive: true });
function extract(args: string[]): string {
  const result = spawnSync(tool, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Source2 extraction failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
extract(['-i', archive, '-o', extracted, '--vpk_extensions', 'vents_c,vwrld_c,vhcg']);
const world = extract(['-i', join(extracted, 'maps/dota/world.vwrld_c'), '-b', 'DATA']);
const compiled = /m_nCompileTimestamp\s*=\s*(\d+)/.exec(world);
if (!compiled) throw new Error('Actual map compile timestamp is absent');
const mapCompiledAt = Number(compiled[1]);
assertRecentMatch(mapCompiledAt, 'Client map compile timestamp');
const layers = ['default_ents', 'world_layer_radiant_base', 'world_layer_dire_base', 'world_layer_radiant_destruction', 'world_layer_dire_destruction'];
const entities: (MapEntity & { layer: string })[] = [];
for (const layer of layers) {
  const input = join(extracted, `maps/dota/entities/${layer}.vents_c`);
  const output = join(extracted, `${layer}.entities.txt`);
  const raw = extract(['-i', input, '-b', 'DATA']);
  const children = /m_childLumps\s*=\s*\[([\s\S]*?)\]/.exec(raw);
  if (!children) throw new Error(`Missing child-lump graph: ${layer}`);
  const references = [...children[1].matchAll(/resource:"maps\/dota\/entities\/([^"]+)\.vents"/g)].map(match => match[1]);
  if (references.some(name => !layers.includes(name))
    || (layer === 'default_ents' ? references.length !== 4 : references.length !== 0)) {
    throw new Error(`Unexpected child-lump graph: ${layer}`);
  }
  extract(['-i', input, '-d', '-o', output]);
  entities.push(...decodeEntityDump(await readFile(output, 'utf8')).map(entity => ({ ...entity, layer })));
}
const trees = entities.filter(entity => entity.classname === 'ent_dota_tree').map(entity => {
  const [x, y, z] = entity.origin!;
  return { x, y, z, layer: entity.layer };
});
if (trees.length !== 2475 || new Set(trees.map(tree => `${tree.x},${tree.y}`)).size !== trees.length) {
  throw new Error('Unexpected current-map permanent-tree coverage');
}
const towers = entities.filter(entity => entity.classname === 'npc_dota_tower');
if (towers.length !== 22) throw new Error('Expected all 22 client tower anchors');
const heightBytes = await readFile(join(extracted, 'maps/dota.vhcg'));
const grid = decodeHeightGrid(heightBytes);
extract(['-i', archive, '-o', extracted, '--vpk_filepath', 'maps/dota/world_physics.vmdl_c']);
const physics = extract(['-i', join(extracted, 'maps/dota/world_physics.vmdl_c'), '-b', 'PHYS']);
const collision = worldCollisionSampler(physics);
const heightValidation = {
  method: 'default-world-collision' as const, maxDeviation: 8,
  checkedSamples: 0, matchedSamples: 0, rejectedSamples: 0,
};
const elevation = encodeHeightRows(grid, { minX: -9472, minY: -9472, maxX: 9472, maxY: 9472 }, 64, (x, y, height) => {
  heightValidation.checkedSamples++;
  const surface = collision(x, y, height);
  if (surface === null || Math.abs(height - surface) > heightValidation.maxDeviation) {
    heightValidation.rejectedSamples++;
    return false;
  }
  heightValidation.matchedSamples++;
  return true;
});
if (heightValidation.matchedSamples < heightValidation.checkedSamples * 0.95) {
  throw new Error('Fewer than 95% of sampled VHCG heights match actual collision surfaces within eight units; publication refused');
}
let maxHeightError = 0;
for (const tower of towers) {
  const [x, y, z] = tower.origin!;
  const height = sampleHeight(grid, x, y);
  if (height === null || Math.abs(height - z) > 0.05) throw new Error(`VHCG height does not align with tower ${tower.targetname}`);
  maxHeightError = Math.max(maxHeightError, Math.abs(height - z));
}
const catalog = catalogSchema.parse(JSON.parse(await readFile('public/scenarios/index.json', 'utf8')));
const compatibility: ClientMap['compatibility'] = [];
for (const entry of catalog.scenarios) {
  if (entry.kind !== 'replay') continue;
  if (!/^\/scenarios\/[a-zA-Z0-9_-]+\.json$/.test(entry.path)) throw new Error('Unsupported catalog scenario path');
  const scenario = scenarioSchema.parse(JSON.parse(await readFile(join('public', entry.path), 'utf8')));
  const source = scenario.source;
  if (source.kind !== 'replay' || !source.matchId) throw new Error('Real scenario needs a match ID');
  assertRecentMatch(source.matchStartTime, `Map compatibility match ${source.matchId}`);
  if (compatibility.some(check => check.matchId === source.matchId)) continue;
  const replay = rawReplaySchema.parse(JSON.parse(await readFile(`.cache/${source.replaySha256}-clarity-4.0.1-v3.json`, 'utf8')));
  if (replay.matchId !== source.matchId) throw new Error('Replay cache match ID mismatch');
  const observed = replay.frames.find(frame => frame.towers?.length === 22)?.towers;
  if (!observed || new Set(observed.map(tower => tower.name)).size !== 22) throw new Error('All 22 named replay tower anchors are required');
  let maxTowerXYError = 0, maxTowerZError = 0;
  for (const tower of observed) {
    const match = towers.find(entity => entity.targetname?.replace(/^\[PR#\]/, '') === tower.name);
    if (!match?.origin || tower.x === null || tower.y === null || tower.z === null) throw new Error(`Missing named tower alignment: ${tower.name}`);
    maxTowerXYError = Math.max(maxTowerXYError, Math.hypot(tower.x - match.origin[0], tower.y - match.origin[1]));
    maxTowerZError = Math.max(maxTowerZError, Math.abs(tower.z - match.origin[2]));
  }
  compatibility.push({ matchId: source.matchId, replaySha256: source.replaySha256, towerCount: 22, maxTowerXYError, maxTowerZError, exactReplayBuild: null });
}
const steam = Object.fromEntries((await readFile(join(client, 'game/dota/steam.inf'), 'utf8')).trim().split(/\r?\n/).map(line => line.split('=')));
if (steam.ClientVersion !== '6934' || steam.SourceRevision !== '11015183') throw new Error('Unexpected downloaded client version');
const map = clientMapSchema.parse({
  version: 1, id: 'dota-6934', coordinateSystem: 'dota-world',
  source: {
    kind: 'valve-client-map', depot: MAP_DEPOT, manifest: MAP_MANIFEST,
    manifestTime: Date.parse('2026-09-18T22:41:29Z') / 1000,
    clientVersion: steam.ClientVersion, sourceRevision: steam.SourceRevision, mapCompiledAt,
    archiveSha256: archiveHash, heightGridSha256: sha256(heightBytes), extractor: 'Source2Viewer 20.0 + dotadle VHCG-v1 decoder',
    heightValidation,
  },
  compatibility, trees, treeState: 'base-positions-only',
  elevation,
  limitations: [
    'Current-client reference geometry: all 22 named tower XYZ anchors checked per replay, but exact replay server build is unknown. Alignment is not proof that every tree or terrain feature is identical.',
    'Base tree positions only. Replay-specific permanent-tree destruction and regrowth are not observed; these markers must not imply trees are currently standing. Sampled temporary-tree and tower changes remain authoritative replay observations.',
    '2475 ent_dota_tree origins from all five entity layers. Eight additional XY positions and one duplicate in the compact TRM resource are not represented as verified tree entities.',
    'Collision-height surface decoded from this exact VHCG-v1 file. Every published sample is checked against actual default-world collision triangles within eight vertical units; unmatched and missing samples stay unknown. The auxiliary float channel is not interpreted. Format support is version-specific, not an official Valve format specification.',
    '64-world-unit cell-centre samples, rounded to one vertical unit, show elevation changes and slopes approximately. They do not establish exact cliff edges, ramp boundaries, traversability or vision. Missing height samples stay unknown.',
  ],
});
const output = 'public/maps/dota-6934.json';
await atomicJson(output, map, { compact: true });
console.log(JSON.stringify({
  output, trees: map.trees.length, heightCells: map.elevation.width * map.elevation.height,
  heightRuns: map.elevation.rows.reduce((sum, row) => sum + row.length, 0),
  maxTowerHeightError: maxHeightError, heightValidation, compatibility, bytes: (await stat(output)).size,
}, null, 2));
