import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeEntityDump, decodeHeightGrid, encodeHeightRows, sampleHeight } from '../ingestion/client-map.js';
import { clientMapEligibility, clientMapSchema } from '../shared/client-map.js';
import { catalogSchema, scenarioSchema } from '../shared/scenario.js';
import { createTestScenario } from './fixtures/scenario.js';
import { worldCollisionSampler } from '../ingestion/collision-check.js';

function heightFixture() {
  const bytes = Buffer.alloc(128 + 2 * 9 + 100);
  bytes.write('vhcg'); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(128, 8);
  bytes.writeUInt32LE(2, 12); bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(5, 20);
  bytes.writeFloatLE(128, 24); bytes.writeFloatLE(-128, 28); bytes.writeFloatLE(-128, 32);
  bytes.writeFloatLE(128, 128); bytes.writeFloatLE(-16384, 132);
  bytes.writeFloatLE(-16384, 137); bytes.writeFloatLE(-16384, 141); bytes[145] = 1;
  for (let row = 0; row < 5; row++) for (let column = 0; column < 5; column++) {
    bytes.writeFloatLE(row * 32 + column * 16, 146 + (row * 5 + column) * 4);
  }
  return bytes;
}

describe('current-client height collision decoding', () => {
  it('uses actual world origins, row-major samples and continuous detail interpolation', () => {
    const grid = decodeHeightGrid(heightFixture());
    expect(sampleHeight(grid, -96, -96)).toBe(128);
    expect(sampleHeight(grid, 0, -128)).toBe(0);
    expect(sampleHeight(grid, 64, -64)).toBe(96);
    expect(sampleHeight(grid, 16, -112)).toBe(24);
    expect(sampleHeight(grid, 200, 200)).toBeNull();
  });
  it('never turns missing heights into zero or bridges missing weighted samples', () => {
    const bytes = heightFixture();
    bytes.writeFloatLE(-16384, 128);
    bytes.writeFloatLE(-16384, 146);
    const grid = decodeHeightGrid(bytes);
    expect(sampleHeight(grid, -96, -96)).toBeNull();
    expect(sampleHeight(grid, 16, -112)).toBeNull();
    expect(sampleHeight(grid, 32, -128)).toBe(16);
  });
  it('uses the explicit detail flag, not a guessed sentinel rule for the constant field', () => {
    const bytes = heightFixture(); bytes.writeFloatLE(0, 137);
    expect(sampleHeight(decodeHeightGrid(bytes), 64, -64)).toBe(96);
  });
  it('fails explicitly for changed headers, flags, malformed buffers and invalid heights', () => {
    for (const offset of [0, 4, 8, 20, 36, 145]) {
      const bytes = heightFixture(); bytes[offset] = 9;
      expect(() => decodeHeightGrid(bytes)).toThrow();
    }
    expect(() => decodeHeightGrid(heightFixture().subarray(0, -1))).toThrow('length');
    const bytes = heightFixture(); bytes.writeFloatLE(NaN, 146);
    expect(() => decodeHeightGrid(bytes)).toThrow('height');
  });
  it('encodes a bounded cell-centre grid with lossless row coverage', () => {
    const rows = encodeHeightRows(decodeHeightGrid(heightFixture()), { minX: -128, minY: -128, maxX: 128, maxY: 0 });
    expect(rows.width).toBe(4);
    expect(rows.height).toBe(2);
    expect(rows.rows).toEqual([[[2, 128], [1, 48], [1, 80]], [[2, 128], [1, 112], [1, 144]]]);
    const filtered = encodeHeightRows(decodeHeightGrid(heightFixture()), { minX: -128, minY: -128, maxX: 128, maxY: 0 }, 64, () => false);
    expect(filtered.rows).toEqual([[[4, null]], [[4, null]]]);
  });
});

function collisionFixture(invalidIndex = false) {
  const vertices = Buffer.alloc(36);
  [0, 0, 128, 128, 0, 256, 0, 128, 128].forEach((value, index) => vertices.writeFloatLE(value, index * 4));
  const triangles = Buffer.alloc(12);
  triangles.writeUInt32LE(1, 4); triangles.writeUInt32LE(invalidIndex ? 3 : 2, 8);
  return [0, 1, 2, 3].map(group => `m_nCollisionAttributeIndex = ${group}\nm_Mesh = {
    m_Vertices = #[${vertices.toString('hex')}]
    m_Triangles = #[${triangles.toString('hex')}]
  }`).join('\n') + '\nm_CollisionGroupString = "default"';
}

describe('independent world collision cross-check', () => {
  it('finds actual sloping triangle intersections without inventing a surface outside the mesh', () => {
    const sample = worldCollisionSampler(collisionFixture());
    expect(sample(32, 32, 160)).toBe(160);
    expect(sample(64, 32, 200)).toBe(192);
    expect(sample(128, 128, 0)).toBeNull();
  });
  it('rejects changed mesh ordering, malformed buffers and out-of-range indices', () => {
    expect(() => worldCollisionSampler(collisionFixture().replace('Index = 0', 'Index = 7'))).toThrow('original order');
    expect(() => worldCollisionSampler(collisionFixture(true))).toThrow('outside vertex buffer');
    expect(() => worldCollisionSampler(collisionFixture().replace('m_Vertices = #[', 'm_Vertices = #[Z'))).toThrow('hex');
  });
});

describe('decoded current-map entities', () => {
  it('preserves observed zero coordinates and tree origin separately from visual scale', () => {
    expect(decodeEntityDump('====0====\nclassname "ent_dota_tree"\norigin [0, 64, 128]\nscales [0.75, 0.75, 0.75]\n'))
      .toEqual([{ classname: 'ent_dota_tree', origin: [0, 64, 128], scales: [0.75, 0.75, 0.75] }]);
  });
  it('refuses missing origins and unsupported template transforms rather than silently misplacing trees', () => {
    expect(() => decodeEntityDump('====0====\nclassname "ent_dota_tree"\n')).toThrow('origin');
    expect(() => decodeEntityDump('====0====\nclassname "point_template"\n')).toThrow('Template');
    expect(() => decodeEntityDump('====0====\nclassname "ent_dota_tree"\norigin [0, 1]\n')).toThrow();
  });
});

const map = clientMapSchema.parse(JSON.parse(readFileSync('public/maps/dota-6934.json', 'utf8')));
const scenario = scenarioSchema.parse(JSON.parse(readFileSync('public/scenarios/replay-9009355617-298767.json', 'utf8')));
const now = Date.parse('2026-09-21T12:00:00Z');
describe('published real client-map contract and compatibility', () => {
  it('contains the exact verified archive, all extracted tree origins and bounded height coverage', () => {
    expect(map.source.archiveSha256).toBe('39aef5c803e8b936646f5f77c6b540c11cb848a6fba7bd7ceebd13b6e2b0705d');
    expect(map.trees).toHaveLength(2475);
    expect(map.elevation.width * map.elevation.height).toBe(87616);
    expect(map.treeState).toBe('base-positions-only');
    const catalog = catalogSchema.parse(JSON.parse(readFileSync('public/scenarios/index.json', 'utf8')));
    const corpus = catalog.scenarios.filter(entry => entry.kind === 'replay').map(entry =>
      scenarioSchema.parse(JSON.parse(readFileSync(`public${entry.path}`, 'utf8'))));
    expect(map.compatibility).toHaveLength(new Set(corpus.map(clip => clip.source.matchId)).size);
    expect(map.compatibility.every(check => check.towerCount === 22)).toBe(true);
    expect(corpus.every(clip => clientMapEligibility(map, clip).eligible)).toBe(true);
    expect(map.compatibility.every(check => check.maxTowerXYError < 0.016 && check.maxTowerZError < 0.032 && check.exactReplayBuild === null)).toBe(true);
    expect(map.trees.find(tree => tree.x === -2560 && tree.y === -8704)?.z).toBe(128);
    expect(map.source.heightValidation).toEqual({
      method: 'default-world-collision', maxDeviation: 8,
      checkedSamples: 81862, matchedSamples: 80726, rejectedSamples: 1136,
    });
  });
  it('uses reference geometry only for recent, explicitly checked replay bytes', () => {
    expect(clientMapEligibility(map, scenario, now).eligible).toBe(true);
    expect(clientMapEligibility(map, createTestScenario(), now).eligible).toBe(false);
    const changed = structuredClone(scenario);
    if (changed.source.kind !== 'replay') throw new Error('Fixture is not real');
    changed.source.replaySha256 = '0'.repeat(64);
    expect(clientMapEligibility(map, changed, now).eligible).toBe(false);
    changed.source = scenario.source.kind === 'replay' ? { ...scenario.source, matchId: '1' } : changed.source;
    expect(clientMapEligibility(map, changed, now).eligible).toBe(false);
    expect(clientMapEligibility({ ...map, source: { ...map.source, manifestTime: 1 } }, scenario, now).eligible).toBe(false);
    expect(clientMapEligibility({ ...map, source: { ...map.source, mapCompiledAt: 1 } }, scenario, now).eligible).toBe(false);
  });
  it('rejects broken RLE coverage instead of silently shifting map coordinates', () => {
    const changed = structuredClone(map);
    changed.elevation.rows[0][0][0]++;
    expect(() => clientMapSchema.parse(changed)).toThrow('exactly cover');
    const unchecked = structuredClone(map); unchecked.source.heightValidation.matchedSamples--;
    expect(() => clientMapSchema.parse(unchecked)).toThrow('every published height sample');
  });
});
