import { scenarioSchema, type RawReplay, type Scenario } from '../shared/scenario.js';
import { encounterBounds, trajectoryBounds, MAX_HERO_SPAN, MAX_SCENARIO_HEROES } from '../shared/encounter.js';

type ReplaySource = Extract<Scenario['source'], { kind: 'replay' }>;
const positionKnown = <T extends { x: number | null; y: number | null }>(h: T): h is T & { x: number; y: number } => h.x !== null && h.y !== null;

export interface ExtractionScan {
  scenarios: Scenario[];
  examinedDeaths: number;
  rejected: Record<string, number>;
}

export function scanScenarios(raw: RawReplay, source: ReplaySource, options: { limit?: number; after?: number; minStartGap?: number } = {}): ExtractionScan {
  const { limit = 3, after = 0, minStartGap = 15 } = options;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(after) || after < 0 || !Number.isFinite(minStartGap) || minStartGap < 0) {
    throw new Error('Invalid extraction scan limits');
  }
  const frames = raw.frames;
  if (frames.some((f, i) => i > 0 && f.time <= frames[i - 1].time)) {
    throw new Error('Parser frames are not strictly ordered');
  }
  const results: Scenario[] = [];
  const rejected: Record<string, number> = {};
  const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  let examinedDeaths = 0;
  const deaths = raw.events.filter(e => e.type === 'death' && e.targetId).sort((a, b) => a.time - b.time);
  for (const death of deaths) {
    if (results.length >= limit) break;
    examinedDeaths++;
    const startIndex = frames.findIndex(f => f.time >= death.time - 6);
    if (startIndex < 0 || frames[startIndex].time >= death.time - 2) { reject('insufficient-setup-lead'); continue; }
    const start = frames[startIndex].time;
    if (start < after) { reject('before-start-threshold'); continue; }
    if (results.some(s => Math.round(s.startTime * 1000) === Math.round(start * 1000))) { reject('duplicate-source-window'); continue; }
    if (results.some(s => Math.abs(s.startTime - start) < minStartGap)) { reject('nearby-selected-window'); continue; }
    const endIndex = frames.findIndex((f, i) => i > startIndex && f.time >= start + 10);
    if (endIndex < 0) { reject('incomplete-continuation'); continue; }
    const clip = frames.slice(startIndex, endIndex + 1);
    // A long parser gap cannot tell a fair ten-second story.
    if (clip.some((f, i) => i > 0 && f.time - clip[i - 1].time > raw.sampleInterval * 2.5)) { reject('frame-gap'); continue; }
    const victim = clip[0].heroes.find(h => h.id === death.targetId);
    if (!victim || victim.alive !== true || !positionKnown(victim)) { reject('victim-not-observed-alive-and-positioned'); continue; }
    const participantIds = new Set<string>([victim.id]);
    const heroIds = new Set(clip.flatMap(frame => frame.heroes.map(hero => hero.id)));
    const isHero = (id: string) => heroIds.has(id) || id.startsWith('npc_dota_hero_');
    let center = victim;
    for (const frame of clip) {
      const observed = frame.heroes.find(h => h.id === victim.id);
      if (observed?.alive === true && positionKnown(observed)) center = observed;
      for (const h of frame.heroes) {
        if (h.alive === false) continue;
        if (!positionKnown(h) || Math.hypot(h.x - center.x, h.y - center.y) <= 2400) participantIds.add(h.id);
      }
    }
    const events = raw.events.filter(e => e.time > start && e.time <= start + 10);
    // Close the whole interaction graph, including remote attackers, their targets and support.
    let previousSize = -1;
    while (participantIds.size !== previousSize) {
      previousSize = participantIds.size;
      for (const event of events) {
        if (event.actorId && event.targetId && isHero(event.actorId) && isHero(event.targetId)
          && (participantIds.has(event.actorId) || participantIds.has(event.targetId))) {
          participantIds.add(event.actorId);
          participantIds.add(event.targetId);
        }
      }
    }
    if (participantIds.size > MAX_SCENARIO_HEROES) { reject('more-than-four-relevant-heroes'); continue; }
    const initial = clip[0].heroes.filter(h => participantIds.has(h.id));
    const ids = new Set(initial.map(h => h.id));
    if (ids.size !== participantIds.size) { reject('participant-missing-from-setup'); continue; }
    if (initial.length < 2 || new Set(initial.map(h => h.team)).size < 2) { reject('insufficient-opposing-participants'); continue; }
    if (clip.some(f => initial.some(h => !f.heroes.some(other => other.id === h.id)))) { reject('missing-participant-samples'); continue; }
    const options = initial.filter(h => h.alive === true).map(h => h.id);
    if (options.length < 2) { reject('insufficient-live-options'); continue; }
    const scopedEvents = events.filter(e => (e.targetId && ids.has(e.targetId)) || (e.actorId && ids.has(e.actorId)));
    const scopedDeaths = scopedEvents.filter(e => e.type === 'death' && e.targetId && options.includes(e.targetId)).sort((a, b) => a.time - b.time);
    const first = scopedDeaths[0];
    if (!first || first.time - start < 2) { reject('insufficient-first-death-lead'); continue; }
    if (scopedDeaths.some(e => e.targetId !== first.targetId && e.time - first.time < raw.sampleInterval)) { reject('ambiguous-first-death'); continue; }
    const heroFrames = clip.map(frame => ({ heroes: frame.heroes.filter(hero => ids.has(hero.id)) }));
    if (heroFrames.some(frame => frame.heroes.some(hero => !positionKnown(hero)))) { reject('participant-position-unknown'); continue; }
    const paths = trajectoryBounds(heroFrames);
    if (!paths) { reject('no-known-positions'); continue; }
    if (paths.maxX - paths.minX > MAX_HERO_SPAN || paths.maxY - paths.minY > MAX_HERO_SPAN) { reject('encounter-too-spread'); continue; }
    const bounds = encounterBounds(heroFrames)!;
    const trajectories = heroFrames.flatMap(frame => frame.heroes).filter(positionKnown);
    const towerIds = new Set(clip.flatMap(f => (f.towers ?? []).filter(positionKnown).filter(t =>
      trajectories.some(h => Math.hypot(h.x - t.x, h.y - t.y) <= 1900),
    ).map(t => t.id)));
    const relativeFrames = clip.map(f => ({
      time: +(f.time - start).toFixed(6),
      heroes: f.heroes.filter(h => ids.has(h.id)),
      ...(f.towers ? { towers: f.towers.filter(t => towerIds.has(t.id)) } : {}),
    }));
    const withTrees = relativeFrames.map((frame, i) => ({
      ...frame,
      ...(clip[i].trees !== undefined ? {
        trees: clip[i].trees?.filter(t => t.x !== null && t.y !== null
          && t.x >= bounds.minX && t.x <= bounds.maxX && t.y >= bounds.minY && t.y <= bounds.maxY) ?? null,
      } : {}),
    }));
    const answer = initial.find(h => h.id === first.targetId)!;
    const scenario = scenarioSchema.parse({
      schemaVersion: 1,
      id: `replay-${source.matchId ?? source.replaySha256.slice(0, 12)}-${Math.round(start * 1000)}`,
      title: 'Ten seconds on the edge',
      description: 'Read the health, positioning, and available resources. Predict the first death among the highlighted heroes.',
      source,
      coordinateSystem: 'dota-world',
      bounds,
      startTime: start,
      duration: 10,
      sampleInterval: raw.sampleInterval,
      question: {
        kind: 'first-death',
        prompt: 'Who dies first in the next 10 seconds?',
        windowSeconds: 10,
        optionIds: options,
        answerId: first.targetId,
        explanation: `${answer.name} is the first observed participant to die, ${(first.time - start).toFixed(1)} seconds after the frozen setup. ${first.description}`,
      },
      startSnapshot: withTrees[0],
      frames: withTrees,
      events: scopedEvents.map(e => ({ ...e, time: +(e.time - start).toFixed(6) })),
      ...(raw.mapContext ? { mapContext: raw.mapContext } : {}),
      limitations: [
        ...raw.limitations,
        'World-coordinate view: terrain, vision, projectiles, and creeps are not reconstructed. Tower/tree layers show only the replay observations described in map provenance.',
        'Participants include living/unknown-life heroes within 2400 world units of the victim (last living location after death), plus the complete connected hero interaction graph. Windows with more than four relevant heroes, unknown participant positions or trajectories spanning over 3200 units on either axis are rejected, never truncated.',
        'The stable camera fits all participant trajectories with 240 units of margin and a minimum 1000-unit extent. Nearby observed towers are retained as context but never expand the camera.',
        'Positions interpolate between recorded samples; other values update at sample boundaries. No counterfactual simulation is performed.',
      ],
    });
    results.push(scenario);
  }
  return { scenarios: results, examinedDeaths, rejected };
}

export function extractScenarios(raw: RawReplay, source: ReplaySource, limit = 3, after = 0): Scenario[] {
  const scan = scanScenarios(raw, source, { limit, after });
  if (!scan.scenarios.length) throw new Error('Replay parsed, but no unambiguous ten-second encounter with complete participant samples was found');
  return scan.scenarios;
}
