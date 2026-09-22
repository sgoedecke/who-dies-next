import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { byteLimiter } from './network.js';

export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function assertReplay(path: string, maxBytes = 1536 * 1024 * 1024): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 16 || info.size > maxBytes) throw new Error('Replay must be a file between 16 bytes and 1.5 GiB');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(8);
    await handle.read(buffer, 0, 8, 0);
    if (!buffer.equals(Buffer.from('PBDEMS2\0'))) throw new Error('Not a Source 2 .dem replay (expected PBDEMS2 header)');
  } finally { await handle.close(); }
}
export async function atomicJson(path: string, value: unknown, options: { compact?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.part`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, options.compact ? undefined : 2) + '\n');
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function readJson(path: string): Promise<unknown> {
  if ((await stat(path)).size > 256 * 1024 * 1024) throw new Error(`JSON exceeds 256 MiB: ${path}`);
  return JSON.parse(await readFile(path, 'utf8'));
}
export function compressionType(header: Buffer): 'bzip2' | 'zstd' {
  if (header.subarray(0, 3).equals(Buffer.from('BZh'))) return 'bzip2';
  if (header.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
  throw new Error('Unknown replay compression: expected bzip2 or Zstandard magic bytes (not an HTML error page)');
}
export async function decompress(input: string, output: string, maxBytes = 1536 * 1024 * 1024): Promise<void> {
  const temporary = `${output}.part`;
  await mkdir(dirname(output), { recursive: true });
  const handle = await open(input, 'r');
  const header = Buffer.alloc(4);
  try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
  // Current Valve URLs can end in .bz2 while carrying a Zstandard stream.
  const codec = compressionType(header);
  const child = spawn(codec, ['-dc', input], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', e => reject(new Error(`Cannot start ${codec}: ${e.message}. Install ${codec} to ingest this compressed replay.`)));
    child.once('close', code => code === 0 ? resolve() : reject(new Error(timedOut ? 'Decompression timed out after 120 seconds' : `${codec} failed (${code}): ${stderr}`)));
  });
  try {
    await Promise.all([exited, pipeline(child.stdout, byteLimiter(maxBytes), createWriteStream(temporary, { flags: 'wx' }))]);
    await assertReplay(temporary, maxBytes);
    await rename(temporary, output);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(temporary, { force: true });
  }
}
export async function runWorker(replay: string, output: string): Promise<void> {
  const temporary = `${output}.part`;
  await mkdir(dirname(output), { recursive: true });
  const child = spawn('bash', ['worker/run.sh', replay, '--output', temporary], { stdio: ['ignore', 'inherit', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { process.stderr.write(chunk); stderr = (stderr + chunk).slice(-8192); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 600_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(timedOut ? 'Parser timed out after ten minutes' : `Clarity worker failed (${code}): ${stderr}`)));
    });
    if (!await exists(temporary)) throw new Error('Parser exited without creating output');
    await rename(temporary, output);
  } finally {
    clearTimeout(timer);
    await rm(temporary, { force: true });
    await rm(`${temporary}.partial`, { force: true });
  }
}
