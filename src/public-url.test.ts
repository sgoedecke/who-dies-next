import { describe, expect, it, vi, afterEach } from 'vitest';
import { publicUrl } from './public-url';
import { localImagePath } from './assets';

afterEach(() => vi.unstubAllEnvs());

describe('deployment-relative public resources', () => {
  for (const base of ['/', '/who-dies-next/']) {
    it(`loads every resource category under ${base}`, () => {
      vi.stubEnv('BASE_URL', base);
      for (const path of ['/scenarios/index.json', '/scenarios/replay-123.json', '/assets/manifest.json',
        '/maps/dota-6934.json', '/assets/heroes/axe.png', '/assets/items/blink.png', '/assets/abilities/axe_call.png']) {
        expect(publicUrl(path)).toBe(`${base}${path.slice(1)}`);
      }
      expect(localImagePath({ status: 'downloaded', path: '/assets/heroes/axe.png', url: 'https://example.com/axe.png' }))
        .toBe(`${base}assets/heroes/axe.png`);
    });
  }
  it('rejects remote URLs, traversal, and ambiguous paths', () => {
    for (const path of ['https://example.com/a.json', '//example.com/a.json', '/assets/../a.png',
      '/assets/%2e%2e/a.png', '/assets//a.png', 'assets/a.png', '/assets/a.png?redirect=1']) {
      expect(() => publicUrl(path, '/who-dies-next/')).toThrow('Invalid public resource path');
    }
    expect(() => publicUrl('/assets/a.png', '//example.com/')).toThrow('Invalid application base path');
  });
});
