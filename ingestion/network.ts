import { setTimeout as sleep } from 'node:timers/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';

export class HttpError extends Error {
  constructor(public status: number, url: string) { super(`HTTP ${status} from ${url}`); }
}
export function replayUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !/^replay\d+\.(valve\.net|steamcontent\.com)$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash
      || !/^\/570\/\d+_\d+\.dem(?:\.bz2)?$/.test(url.pathname)) {
    throw new Error(`Rejected non-Valve or malformed replay URL: ${url.origin}${url.pathname}`);
  }
  return url;
}
export async function jsonRequest(
  url: string,
  options: { fetcher?: typeof fetch; wait?: typeof sleep; attempts?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? sleep;
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetcher(url, {
        headers: { 'User-Agent': 'dotadle-prototype/0.1', Accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt < attempts - 1) {
          const retrySeconds = Number(response.headers.get('retry-after'));
          await wait(Math.min(30_000, Math.max(2000 * 2 ** attempt, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0)));
          continue;
        }
        throw new HttpError(response.status, url);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`Empty JSON response from ${url}`);
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('API response exceeds 8 MiB'); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof HttpError || error instanceof SyntaxError || attempt === attempts - 1) throw error;
      await wait(2000 * 2 ** attempt);
    }
  }
  throw new Error('No request attempts configured');
}
export function byteLimiter(maxBytes: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error(`Stream exceeds ${maxBytes} byte limit`) : null, chunk);
    },
  });
}
export async function downloadReplay(
  input: string,
  destination: string,
  options: { maxBytes?: number; timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<void> {
  let url = replayUrl(input);
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const temporary = `${destination}.part`;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 180_000);
  await mkdir(dirname(destination), { recursive: true });
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await (options.fetcher ?? fetch)(url, {
        redirect: 'manual', signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('Replay redirect limit or missing location');
        url = replayUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status, url.href); }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new Error(`Replay exceeds ${maxBytes} byte download limit`);
      }
      if (!response.body) throw new Error('Replay response has no body');
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        byteLimiter(maxBytes),
        createWriteStream(temporary, { flags: 'wx' }),
      );
      await rename(temporary, destination);
      return;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
