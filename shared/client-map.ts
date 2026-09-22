import { z } from 'zod';
import { matchEligibility, scenarioEligibility } from './recent.js';
import type { Scenario } from './scenario.js';

const finite = z.number().finite();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const clientMapSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  coordinateSystem: z.literal('dota-world'),
  source: z.object({
    kind: z.literal('valve-client-map'),
    depot: z.string(), manifest: z.string(), manifestTime: z.number().int().positive(),
    clientVersion: z.string(), sourceRevision: z.string(), mapCompiledAt: z.number().int().positive(),
    archiveSha256: digest, heightGridSha256: digest,
    extractor: z.string(),
    heightValidation: z.object({
      method: z.literal('default-world-collision'),
      maxDeviation: finite.nonnegative().max(8),
      checkedSamples: z.number().int().nonnegative(),
      matchedSamples: z.number().int().nonnegative(),
      rejectedSamples: z.number().int().nonnegative(),
    }),
  }),
  compatibility: z.array(z.object({
    matchId: z.string(), replaySha256: digest,
    towerCount: z.literal(22),
    maxTowerXYError: finite.nonnegative().max(1),
    maxTowerZError: finite.nonnegative().max(1),
    exactReplayBuild: z.null(),
  })),
  trees: z.array(z.object({ x: finite, y: finite, z: finite, layer: z.string() })),
  treeState: z.literal('base-positions-only'),
  elevation: z.object({
    source: z.literal('vhcg-v1'),
    minX: finite, minY: finite, cellSize: finite.positive(),
    width: z.number().int().positive().max(1024),
    height: z.number().int().positive().max(1024),
    rows: z.array(z.array(z.tuple([z.number().int().positive(), finite.nullable()]))),
  }),
  limitations: z.array(z.string()).min(1),
}).superRefine((map, ctx) => {
  if (map.elevation.rows.length !== map.elevation.height
    || map.elevation.rows.some(row => row.reduce((sum, run) => sum + run[0], 0) !== map.elevation.width)) {
    ctx.addIssue({ code: 'custom', message: 'Elevation RLE rows must exactly cover the declared grid' });
  }
  if (new Set(map.compatibility.map(entry => entry.matchId)).size !== map.compatibility.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate map compatibility match' });
  }
  const validation = map.source.heightValidation;
  const visible = map.elevation.rows.reduce((sum, row) => sum + row.reduce((count, run) => count + (run[1] === null ? 0 : run[0]), 0), 0);
  if (validation.checkedSamples !== validation.matchedSamples + validation.rejectedSamples || validation.matchedSamples !== visible) {
    ctx.addIssue({ code: 'custom', message: 'Collision validation counts must cover every published height sample' });
  }
});

export type ClientMap = z.infer<typeof clientMapSchema>;

export function clientMapEligibility(map: ClientMap, scenario: Scenario, nowMs = Date.now()): { eligible: boolean; reason: string } {
  if (scenario.source.kind !== 'replay') return { eligible: false, reason: 'Synthetic map' };
  if (!scenarioEligibility(scenario, nowMs).eligible) return { eligible: false, reason: 'Replay is not recent' };
  if (!matchEligibility(map.source.manifestTime, nowMs).eligible
    || !matchEligibility(map.source.mapCompiledAt, nowMs).eligible) return { eligible: false, reason: 'Client map is not recent' };
  const source = scenario.source;
  if (!map.compatibility.some(entry => entry.matchId === source.matchId && entry.replaySha256 === source.replaySha256)) {
    return { eligible: false, reason: 'Client map alignment has not been checked for this replay' };
  }
  return { eligible: true, reason: 'Tower-aligned current client reference; exact replay build unverified' };
}
