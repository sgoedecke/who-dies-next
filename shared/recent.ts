export const MAX_MATCH_AGE_DAYS = 180;
export const MAX_MATCH_AGE_SECONDS = MAX_MATCH_AGE_DAYS * 24 * 60 * 60;

export type MatchEligibility =
  | { eligible: true; reason: null; message: null }
  | { eligible: false; reason: 'unknown-age' | 'too-old' | 'future-start'; message: string };

export function matchEligibility(startTime: number | null | undefined, nowMs = Date.now()): MatchEligibility {
  if (startTime === null || startTime === undefined || !Number.isSafeInteger(startTime) || startTime <= 0) {
    return { eligible: false, reason: 'unknown-age', message: 'Match age is unknown: a verified match-start timestamp is required. Download and file modification dates do not establish match age.' };
  }
  const now = Math.floor(nowMs / 1000);
  if (startTime > now) {
    return { eligible: false, reason: 'future-start', message: 'The match-start timestamp is in the future and cannot establish eligibility.' };
  }
  if (startTime < now - MAX_MATCH_AGE_SECONDS) {
    return { eligible: false, reason: 'too-old', message: `This match started on ${new Date(startTime * 1000).toISOString().slice(0, 10)}, outside the rolling ${MAX_MATCH_AGE_DAYS}-day window.` };
  }
  return { eligible: true, reason: null, message: null };
}

export function scenarioEligibility(
  scenario: { source: { kind: 'replay'; matchStartTime?: number | null } },
  nowMs = Date.now(),
): MatchEligibility {
  return matchEligibility(scenario.source.matchStartTime, nowMs);
}

export function assertRecentMatch(startTime: number | null | undefined, context: string, nowMs = Date.now()): asserts startTime is number {
  const eligibility = matchEligibility(startTime, nowMs);
  if (!eligibility.eligible) throw new Error(`${context}: ${eligibility.message}`);
}
