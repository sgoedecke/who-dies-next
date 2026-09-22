import { describe, expect, it } from 'vitest';
import { MAP_FILE_PATHS, MAP_MANIFEST, MAP_PAYLOAD_LIMIT, selectCurrentMapFiles } from '../ingestion/map-assets.js';
import { MAX_MATCH_AGE_SECONDS } from '../shared/recent.js';

const now = Date.parse('2026-09-21T10:00:00Z');
function fixture(date = '09/18/2026 22:41:29', size = 100) {
  return `Content Manifest for Depot 373301 \nManifest ID / date     : ${MAP_MANIFEST} / ${date} \n`
    + MAP_FILE_PATHS.map(path => `${size} 1 ${'a'.repeat(40)} 0 ${path}`).join('\n');
}

describe('bounded current-map acquisition allowlist', () => {
  it('selects only exact current files, ignoring old maps and the rest of the depot', () => {
    const manifest = fixture() + `\n900000000 999 ${'b'.repeat(40)} 0 game/dota/maps/dota_683.vpk`;
    expect(selectCurrentMapFiles(manifest, now).map(file => file.path)).toEqual(MAP_FILE_PATHS);
  });
  it('fails closed on missing, wildcard, duplicate and non-file entries', () => {
    for (const manifest of [
      fixture().replace('game/dota/maps/dota.vpk', 'game/dota/maps/*'),
      fixture() + `\n100 1 ${'a'.repeat(40)} 0 game/dota/maps/dota.vpk`,
      fixture().replace(' 0 game/dota/maps/dota.vpk', ' 64 game/dota/maps/dota.vpk'),
    ]) expect(() => selectCurrentMapFiles(manifest, now)).toThrow('Exact regular file');
  });
  it('rejects oversized payloads and invalid byte sizes', () => {
    expect(() => selectCurrentMapFiles(fixture(undefined, MAP_PAYLOAD_LIMIT), now)).toThrow('100 MiB');
    expect(() => selectCurrentMapFiles(fixture(undefined, 0), now)).toThrow('Invalid map file size');
  });
  it('requires the pinned depot/manifest, full checksum and valid date', () => {
    for (const manifest of [
      fixture().replace('Depot 373301', 'Depot 123'),
      fixture().replace(MAP_MANIFEST, '123'),
      fixture().replace('a'.repeat(40), 'a'.repeat(39)),
      fixture('02/31/2026 22:41:29'),
      fixture('13/01/2026 22:41:29'),
    ]) expect(() => selectCurrentMapFiles(manifest, now)).toThrow();
  });
  it('rejects stale and future assets independently of download date', () => {
    expect(() => selectCurrentMapFiles(fixture('09/22/2026 00:00:00'), now)).toThrow('future-start');
    expect(() => selectCurrentMapFiles(fixture('01/01/2026 00:00:00'), now)).toThrow('too-old');
    const boundary = Date.parse('2026-09-18T22:41:29Z') + MAX_MATCH_AGE_SECONDS * 1000;
    expect(selectCurrentMapFiles(fixture(), boundary)).toHaveLength(3);
    expect(() => selectCurrentMapFiles(fixture(), boundary + 1000)).toThrow('too-old');
  });
});
