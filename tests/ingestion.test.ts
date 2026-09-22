import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { byteLimiter, downloadReplay, HttpError, jsonRequest, replayUrl } from '../ingestion/network.js';
import { assertReplay, compressionType, decompress, exists } from '../ingestion/files.js';

const folders: string[] = [];
async function temp(): Promise<string> {
  await mkdir('.cache', { recursive: true });
  const folder = await mkdtemp('.cache/test-'); folders.push(folder); return folder;
}
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
const url = 'http://replay181.valve.net/570/9009355617_705412918.dem.bz2';
describe('safe replay acquisition', () => {
  it('only accepts strict Valve replay paths', () => {
    expect(replayUrl(url).hostname).toBe('replay181.valve.net');
    for (const bad of ['http://127.0.0.1/x', 'file:///etc/passwd', 'https://replay1.valve.net.evil.test/570/1_2.dem', 'http://user@replay1.valve.net/570/1_2.dem', 'http://replay1.valve.net:8080/570/1_2.dem']) {
      expect(() => replayUrl(bad)).toThrow();
    }
  });
  it('bounds API rate-limit retries and honors retry-after', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3' } }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const wait = vi.fn().mockResolvedValue(undefined);
    expect(await jsonRequest('https://api.opendota.com/api/test', { fetcher, wait })).toEqual({ ok: true });
    expect(wait).toHaveBeenCalledWith(3000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('makes at most three attempts on server failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503 }));
    await expect(jsonRequest('https://api.opendota.com/api/test', { fetcher, wait: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow('503');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('reports missing/expired replays without retrying 404', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 }));
    await expect(jsonRequest('https://api.opendota.com/api/test', { fetcher })).rejects.toBeInstanceOf(HttpError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid JSON without success-shaped fallback', async () => {
    await expect(jsonRequest('https://api.opendota.com/api/test', { fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>')) })).rejects.toBeInstanceOf(SyntaxError);
  });
  it('streams a download and atomically publishes it', async () => {
    const file = join(await temp(), 'test.bz2');
    await downloadReplay(url, file, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('BZh9data')) });
    expect(await readFile(file, 'utf8')).toBe('BZh9data');
    expect(await exists(`${file}.part`)).toBe(false);
  });
  it('rejects announced and streamed oversized bodies and removes partial files', async () => {
    const file = join(await temp(), 'test.bz2');
    for (const headers of [new Headers({ 'content-length': '1000' }), new Headers()]) {
      await expect(downloadReplay(url, file, { maxBytes: 3, fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('too much data', { headers })) })).rejects.toThrow('limit');
      expect(await exists(file)).toBe(false);
      expect(await exists(`${file}.part`)).toBe(false);
    }
  });
  it('rejects redirects to arbitrary hosts', async () => {
    await expect(downloadReplay(url, join(await temp(), 'test.bz2'), {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })),
    })).rejects.toThrow('Rejected');
  });
  it('enforces a streaming decompression output limit', async () => {
    await expect(pipeline(Readable.from([Buffer.alloc(100)]), byteLimiter(20), new Writable({ write(_c, _e, cb) { cb(); } }))).rejects.toThrow('byte limit');
  });
  it('recognizes modern Zstandard despite a .bz2 URL suffix', () => {
    expect(compressionType(Buffer.from('BZh9'))).toBe('bzip2');
    expect(compressionType(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toBe('zstd');
    expect(() => compressionType(Buffer.from('<html>'))).toThrow('Unknown replay compression');
  });
  it('rejects corrupt replay and compression headers', async () => {
    const folder = await temp();
    const file = join(folder, 'bad.dem');
    await writeFile(file, '<html>Not actually a replay</html>');
    await expect(assertReplay(file)).rejects.toThrow('Source 2');
    await expect(decompress(file, join(folder, 'out.dem'))).rejects.toThrow('compression');
    expect(await exists(join(folder, 'out.dem'))).toBe(false);
  });
  it('decompresses actual bzip2 data and rejects an expansion above its limit', async () => {
    const folder = await temp();
    const input = join(folder, 'fixture.dem.bz2');
    const data = Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(1024)]);
    const compressed = spawnSync('bzip2', ['-c'], { input: data });
    expect(compressed.status).toBe(0);
    await writeFile(input, compressed.stdout);
    const output = join(folder, 'fixture.dem');
    await decompress(input, output);
    expect(await readFile(output)).toEqual(data);
    const limited = join(folder, 'limited.dem');
    await expect(decompress(input, limited, 64)).rejects.toThrow('byte limit');
    expect(await exists(limited)).toBe(false);
    expect(await exists(`${limited}.part`)).toBe(false);
  });
  it('fails on a truncated bzip2 stream instead of publishing partial data', async () => {
    const folder = await temp();
    const input = join(folder, 'broken.bz2');
    await writeFile(input, 'BZh9incomplete');
    const output = join(folder, 'broken.dem');
    await expect(decompress(input, output)).rejects.toThrow('bzip2 failed');
    expect(await exists(output)).toBe(false);
  });
});
