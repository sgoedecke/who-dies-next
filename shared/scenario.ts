import { z } from 'zod';
import { MAX_SCENARIO_HEROES, MAX_HERO_SPAN, trajectoryBounds } from './encounter.js';

const nullableNumber = z.number().finite().nullable();
export const heroSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  team: z.enum(['radiant', 'dire']),
  level: z.number().int().nonnegative().nullable().default(null),
  x: nullableNumber,
  y: nullableNumber,
  hp: nullableNumber,
  maxHp: nullableNumber,
  mana: nullableNumber,
  maxMana: nullableNumber,
  alive: z.boolean().nullable(),
  abilities: z.array(z.object({
    name: z.string(), level: nullableNumber, cooldown: nullableNumber,
  })),
  items: z.array(z.object({
    name: z.string(), charges: nullableNumber, cooldown: nullableNumber,
  })),
  effects: z.array(z.string()).nullable(),
});
export const towerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  team: z.enum(['radiant', 'dire']),
  x: nullableNumber, y: nullableNumber, z: nullableNumber,
  hp: nullableNumber, maxHp: nullableNumber,
  alive: z.boolean().nullable(),
});
export const treeSchema = z.object({
  id: z.string().min(1),
  x: nullableNumber, y: nullableNumber, z: nullableNumber,
  alive: z.boolean().nullable(),
});
export const mapContextSchema = z.object({
  towerSource: z.string(),
  treeSource: z.string(),
  treeCoverage: z.enum(['all', 'temporary-only', 'unavailable']),
  terrainSource: z.string().nullable(),
  limitations: z.array(z.string()),
});
export const frameSchema = z.object({
  time: z.number().finite().nonnegative(),
  heroes: z.array(heroSchema),
  towers: z.array(towerSchema).optional(),
  trees: z.array(treeSchema).nullable().optional(),
});
export const eventSchema = z.object({
  time: z.number().finite().nonnegative(),
  type: z.enum(['death', 'damage', 'ability', 'item', 'modifier']),
  actorId: z.string().nullable(),
  targetId: z.string().nullable(),
  ability: z.string().nullable(),
  value: nullableNumber,
  description: z.string(),
});
export const rawReplaySchema = z.object({
  schemaVersion: z.literal(1),
  matchId: z.string().nullable(),
  matchStartTime: z.number().int().positive().nullable().default(null),
  patch: z.string().nullable(),
  parser: z.object({ name: z.literal('clarity'), version: z.string() }),
  coordinateSystem: z.literal('dota-world'),
  sampleInterval: z.number().positive(),
  frames: z.array(frameSchema).min(2),
  events: z.array(eventSchema),
  limitations: z.array(z.string()),
  mapContext: mapContextSchema.optional(),
});
export const sourceSchema = z.object({
    kind: z.literal('replay'),
    label: z.string(),
    matchId: z.string().nullable(),
    patch: z.string().nullable(),
    matchStartTime: z.number().int().positive().nullable().default(null),
    matchStartTimeSource: z.string().nullable().default(null),
    replaySha256: z.string().regex(/^[0-9a-f]{64}$/),
    parser: z.string(),
    extractedAt: z.iso.datetime(),
    acquisition: z.string(),
});
// Historical files can be read for migration, but never used as the playable contract.
export const scenarioArchiveSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string(),
  description: z.string(),
  source: sourceSchema,
  coordinateSystem: z.literal('dota-world'),
  bounds: z.object({ minX: z.number(), maxX: z.number(), minY: z.number(), maxY: z.number() }),
  startTime: z.number().nonnegative(),
  duration: z.number().positive().max(30),
  sampleInterval: z.number().positive(),
  question: z.object({
    kind: z.literal('first-death'),
    prompt: z.string(),
    windowSeconds: z.number().positive(),
    optionIds: z.array(z.string()).min(2),
    answerId: z.string(),
    explanation: z.string(),
  }),
  startSnapshot: frameSchema,
  frames: z.array(frameSchema).min(2),
  events: z.array(eventSchema),
  limitations: z.array(z.string()),
  mapContext: mapContextSchema.optional(),
}).superRefine((s, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (s.bounds.minX >= s.bounds.maxX || s.bounds.minY >= s.bounds.maxY) error('Invalid arena bounds');
  if (s.question.windowSeconds !== s.duration) error('Question must cover the entire continuation');
  if (s.startSnapshot.time !== 0 || s.frames[0].time !== 0) error('Snapshots use scenario-relative time starting at zero');
  if (JSON.stringify(s.startSnapshot) !== JSON.stringify(s.frames[0])) error('Start snapshot must equal first frame');
  if (s.frames.at(-1)!.time < s.duration) error('Continuation must cover the whole question window');
  const ids = s.startSnapshot.heroes.map(h => h.id);
  if (new Set(ids).size !== ids.length) error('Duplicate hero IDs');
  if (new Set(s.question.optionIds).size !== s.question.optionIds.length) error('Duplicate answer options');
  if (s.question.optionIds.some(id => !ids.includes(id))) error('Answer options must be visible heroes');
  if (s.question.optionIds.some(id => s.startSnapshot.heroes.find(h => h.id === id)?.alive !== true)) error('Answer options must be observed alive in the setup');
  if (!s.question.optionIds.includes(s.question.answerId)) error('Answer must be an offered hero');
  for (let i = 0; i < s.frames.length; i++) {
    if (i > 0 && s.frames[i].time <= s.frames[i - 1].time) error('Frames must be strictly time ordered');
    if (s.frames[i].heroes.length !== ids.length || new Set(s.frames[i].heroes.map(h => h.id)).size !== ids.length || s.frames[i].heroes.some(h => !ids.includes(h.id))) error('Every frame must preserve the participant set');
    const towers = s.frames[i].towers ?? [];
    const trees = s.frames[i].trees ?? [];
    if (new Set(towers.map(t => t.id)).size !== towers.length) error('Duplicate tower IDs in frame');
    if (new Set(trees.map(t => t.id)).size !== trees.length) error('Duplicate tree IDs in frame');
  }
  const deaths = s.events.filter(e => e.type === 'death' && e.time > 0 && e.time <= s.duration && e.targetId && s.question.optionIds.includes(e.targetId)).sort((a, b) => a.time - b.time);
  if (!deaths.length || deaths[0].targetId !== s.question.answerId) error('Answer must be derived from the first participant death');
  if (deaths.length > 1 && Math.abs(deaths[1].time - deaths[0].time) < s.sampleInterval && deaths[1].targetId !== deaths[0].targetId) error('Ambiguous simultaneous first deaths');
  if (s.events.some(e => e.time > s.duration)) error('Event outside continuation');
});
export const scenarioSchema = scenarioArchiveSchema.superRefine((scenario, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (scenario.startSnapshot.heroes.length > MAX_SCENARIO_HEROES) error('Playable snippets contain at most four relevant heroes');
  const bounds = trajectoryBounds(scenario.frames);
  if (scenario.source.kind === 'replay') {
    if (scenario.frames.some(frame => frame.heroes.some(hero => hero.x === null || hero.y === null))) error('Replay participant positions must be known throughout the snippet');
    if (bounds && (bounds.maxX - bounds.minX > MAX_HERO_SPAN || bounds.maxY - bounds.minY > MAX_HERO_SPAN)) error('Replay participant trajectories exceed the 3200-unit framing limit');
  }
  if (bounds && (bounds.minX < scenario.bounds.minX || bounds.maxX > scenario.bounds.maxX
    || bounds.minY < scenario.bounds.minY || bounds.maxY > scenario.bounds.maxY)) error('The camera must contain all known participant positions');
});
export const catalogSchema = z.object({
  version: z.literal(1),
  scenarios: z.array(z.object({
    id: z.string(), title: z.string(), kind: z.literal('replay'), path: z.string(),
    matchStartTime: z.number().int().positive().nullable().optional(),
  })).min(1),
  daily: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.string()),
  retiredQuestionIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).optional(),
}).superRefine((catalog, ctx) => {
  const retired = new Set(catalog.retiredQuestionIds ?? []);
  if (catalog.scenarios.some(scenario => retired.has(scenario.id))) ctx.addIssue({ code: 'custom', message: 'Retired question IDs cannot be active catalog entries' });
});
export type Hero = z.infer<typeof heroSchema>;
export type Frame = z.infer<typeof frameSchema>;
export type ReplayEvent = z.infer<typeof eventSchema>;
export type RawReplay = z.infer<typeof rawReplaySchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type Tower = z.infer<typeof towerSchema>;
export type Tree = z.infer<typeof treeSchema>;
export type MapContext = z.infer<typeof mapContextSchema>;

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}
