import { scenarioEligibility } from '../shared/recent';
import type { Catalog } from '../shared/scenario';

export function catalogEntryAvailability(entry: Catalog['scenarios'][number], nowMs = Date.now()) {
  return scenarioEligibility({ source: entry }, nowMs);
}

export function eligiblePracticeEntries(catalog: Catalog, nowMs = Date.now(), rejectedIds: string[] = []): Catalog['scenarios'] {
  const rejected = new Set(rejectedIds);
  return catalog.scenarios.filter(entry => entry.kind === 'replay' && !rejected.has(entry.id) && catalogEntryAvailability(entry, nowMs).eligible);
}

export function randomPracticeId(entries: Catalog['scenarios'], selectedId: string | null, random = Math.random): string | null {
  const candidates = entries.filter(entry => entry.id !== selectedId);
  return candidates.length ? candidates[Math.floor(random() * candidates.length)].id : null;
}

export function availabilityLabel(entry: Catalog['scenarios'][number], nowMs = Date.now()): string {
  const status = catalogEntryAvailability(entry, nowMs);
  if (status.eligible) return 'Recent replay';
  if (status.reason === 'unknown-age') return 'Unavailable — match age unknown';
  if (status.reason === 'future-start') return 'Unavailable — future match timestamp';
  return 'Unavailable — older than 180 days';
}
