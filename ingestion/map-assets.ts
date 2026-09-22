import { MAX_MATCH_AGE_DAYS, matchEligibility } from '../shared/recent.js';

export const MAP_DEPOT = '373301';
export const MAP_MANIFEST = '693476521428628584';
export const MAP_PAYLOAD_LIMIT = 100 * 1024 * 1024;
export const MAP_FILE_PATHS = [
  'game/dota/maps/dota.vpk',
  'game/dota/pak01_dir.vpk',
  'game/dota/steam.inf',
] as const;

export interface MapAssetFile { path: string; size: number; sha1: string }

export function selectCurrentMapFiles(manifest: string, nowMs = Date.now()): MapAssetFile[] {
  const lines = manifest.split(/\r?\n/).map(line => line.trimEnd());
  if (!lines.includes(`Content Manifest for Depot ${MAP_DEPOT}`)) throw new Error('Unexpected map depot');
  const stamp = lines.find(line => line.startsWith('Manifest ID / date'))?.match(
    /^Manifest ID \/ date\s*:\s*(\d+) \/ (\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!stamp || stamp[1] !== MAP_MANIFEST) throw new Error('Expected current content manifest and timestamp are required');
  const [, , month, day, year, hour, minute, second] = stamp;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const date = Date.parse(iso);
  if (!Number.isFinite(date) || new Date(date).toISOString() !== iso) throw new Error('Invalid manifest date');
  const age = matchEligibility(date / 1000, nowMs);
  if (!age.eligible) throw new Error(`Client manifest must be within the rolling ${MAX_MATCH_AGE_DAYS}-day window: ${age.reason}`);
  const selected = MAP_FILE_PATHS.map(path => {
    const matching = lines.filter(line => line.endsWith(` ${path}`));
    const entry = matching[0]?.match(/^\s*(\d+)\s+\d+\s+([0-9a-f]{40})\s+0\s+(.+)$/);
    if (matching.length !== 1 || !entry || entry[3] !== path) throw new Error(`Exact regular file missing or ambiguous: ${path}`);
    const size = Number(entry[1]);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`Invalid map file size: ${path}`);
    return { path, size, sha1: entry[2] };
  });
  if (selected.reduce((sum, file) => sum + file.size, 0) > MAP_PAYLOAD_LIMIT) throw new Error('Selected map files exceed the 100 MiB payload cap');
  return selected;
}
