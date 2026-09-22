import { z } from 'zod';

const ABSENT_HEIGHT = -16384;
export interface HeightGrid {
  width: number; height: number; cellSize: number; minX: number; minY: number;
  constant: Float32Array; details: Map<number, Float32Array>;
}

// This decoder intentionally supports only the layout verified in client 6934.
export function decodeHeightGrid(bytes: Buffer): HeightGrid {
  if (bytes.length < 128 || bytes.toString('ascii', 0, 4) !== 'vhcg'
    || bytes.readUInt32LE(4) !== 1 || bytes.readUInt32LE(8) !== 128 || bytes.readUInt32LE(20) !== 5) {
    throw new Error('Unsupported VHCG header; current decoder requires v1, 128-byte header and 5x5 detail samples');
  }
  if (bytes.subarray(36, 128).some(byte => byte !== 0)) throw new Error('Unknown VHCG reserved header fields');
  const width = bytes.readUInt32LE(12), height = bytes.readUInt32LE(16);
  const cellSize = bytes.readFloatLE(24), minX = bytes.readFloatLE(28), minY = bytes.readFloatLE(32);
  const count = width * height;
  if (!width || !height || width > 2048 || height > 2048 || !Number.isFinite(cellSize) || cellSize <= 0
    || !Number.isFinite(minX) || !Number.isFinite(minY) || bytes.length < 128 + count * 9) throw new Error('Invalid VHCG dimensions');
  const constant = new Float32Array(count), detailed: number[] = [];
  function readHeight(offset: number): number {
    const value = bytes.readFloatLE(offset);
    if (!Number.isFinite(value) || value < ABSENT_HEIGHT || value > 16384) throw new Error('Invalid VHCG height');
    return value;
  }
  for (let index = 0; index < count; index++) {
    const offset = 128 + index * 9;
    constant[index] = readHeight(offset);
    readHeight(offset + 4); // Preserve framing without assigning unverified semantics to the auxiliary channel.
    const flag = bytes[offset + 8];
    if (flag > 1) throw new Error('Unknown VHCG detail flag');
    if (flag === 1) {
      detailed.push(index);
    }
  }
  let offset = 128 + count * 9;
  if (offset + detailed.length * 100 !== bytes.length) throw new Error('VHCG detail payload length mismatch');
  const details = new Map<number, Float32Array>();
  for (const index of detailed) {
    const samples = new Float32Array(25);
    for (let i = 0; i < 25; i++, offset += 4) samples[i] = readHeight(offset);
    details.set(index, samples);
  }
  return { width, height, cellSize, minX, minY, constant, details };
}

export function sampleHeight(grid: HeightGrid, x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Height sample coordinates must be finite');
  const gx = (x - grid.minX) / grid.cellSize, gy = (y - grid.minY) / grid.cellSize;
  const column = Math.floor(gx), row = Math.floor(gy);
  if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return null;
  const index = row * grid.width + column, detail = grid.details.get(index);
  if (!detail) return grid.constant[index] === ABSENT_HEIGHT ? null : grid.constant[index];
  const u = (gx - column) * 4, v = (gy - row) * 4;
  const left = Math.min(3, Math.floor(u)), bottom = Math.min(3, Math.floor(v));
  const du = u - left, dv = v - bottom;
  const taps = [
    [detail[bottom * 5 + left], (1 - du) * (1 - dv)],
    [detail[bottom * 5 + left + 1], du * (1 - dv)],
    [detail[(bottom + 1) * 5 + left], (1 - du) * dv],
    [detail[(bottom + 1) * 5 + left + 1], du * dv],
  ];
  let result = 0;
  for (const [value, weight] of taps) {
    if (weight === 0) continue;
    if (value === ABSENT_HEIGHT) return null;
    result += value * weight;
  }
  return result;
}

const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const entitySchema = z.object({
  classname: z.string(),
  origin: vector.optional(),
  targetname: z.string().optional(),
  angles: vector.optional(),
  scales: vector.optional(),
});
export type MapEntity = z.infer<typeof entitySchema>;
export function decodeEntityDump(text: string): MapEntity[] {
  if (!/^====0====$/m.test(text)) throw new Error('Expected a Source2Viewer decoded entity dump');
  const entities: MapEntity[] = [];
  for (const block of text.split(/^====\d+====$/m).slice(1)) {
    const fields: Record<string, unknown> = {};
    for (const line of block.split('\n')) {
      const match = /^(classname|origin|targetname|angles|scales)\s+(.+)$/.exec(line);
      if (!match) continue;
      if (match[1] in fields) throw new Error(`Duplicate entity field: ${match[1]}`);
      fields[match[1]] = JSON.parse(match[2]);
    }
    const entity = entitySchema.parse(fields);
    if (entity.classname === 'point_template' || /\bentitylumpname\s+/.test(block)) {
      throw new Error('Template entity encountered; composed transforms require a new verified extraction implementation');
    }
    if (['ent_dota_tree', 'npc_dota_tower'].includes(entity.classname) && !entity.origin) {
      throw new Error(`Missing actual origin for ${entity.classname}`);
    }
    entities.push(entity);
  }
  return entities;
}

export function encodeHeightRows(
  grid: HeightGrid, bounds: { minX: number; minY: number; maxX: number; maxY: number }, cellSize = 64,
  validate?: (x: number, y: number, height: number) => boolean,
) {
  const width = (bounds.maxX - bounds.minX) / cellSize, height = (bounds.maxY - bounds.minY) / cellSize;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error('Height output bounds must align to cells');
  const rows: [number, number | null][][] = [];
  for (let row = 0; row < height; row++) {
    const runs: [number, number | null][] = [];
    for (let column = 0; column < width; column++) {
      const x = bounds.minX + (column + 0.5) * cellSize, y = bounds.minY + (row + 0.5) * cellSize;
      const sampled = sampleHeight(grid, x, y);
      let value = sampled === null ? null : Math.round(sampled);
      if (value !== null && validate && !validate(x, y, value)) value = null;
      const previous = runs.at(-1);
      if (previous && previous[1] === value) previous[0]++;
      else runs.push([1, value]);
    }
    rows.push(runs);
  }
  return { source: 'vhcg-v1' as const, minX: bounds.minX, minY: bounds.minY, cellSize, width, height, rows };
}
