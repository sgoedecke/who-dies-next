import { expect, it } from 'vitest';
import { parseLargeJson } from '../ingestion/files.js';
it('matches JSON.parse', () => {
  const value = { a: 1, s: 'x,"}]{[\\\\', n: null, frames: [{ t: 1, h: [1, { q: '"]' }] }, 2, 'z', []], empty: [], o: { k: [1] }, f: -1.5e3, b: true };
  for (const space of [undefined, 2]) expect(parseLargeJson(Buffer.from(JSON.stringify(value, null, space)))).toEqual(value);
});
