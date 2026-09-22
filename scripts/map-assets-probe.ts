import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { atomicJson, exists, sha256 } from '../ingestion/files.js';

const { values } = parseArgs({
  options: {
    tool: { type: 'string', default: '.tools/depot-downloader/DepotDownloader' },
    depot: { type: 'string', default: '373301' },
    manifest: { type: 'string', default: '693476521428628584' },
  },
});
for (const key of ['depot', 'manifest'] as const) {
  if (!/^\d{1,20}$/.test(values[key]!)) throw new Error(`--${key} must be a numeric Steam identifier`);
}
const tool = resolve(values.tool!);
if (!await exists(tool)) throw new Error('DepotDownloader is missing. See docs/map-assets.md for the official project-local installation; no account is required for this anonymous probe.');
const root = resolve('.cache/terrain');
const output = resolve(root, 'depot-manifest');
await mkdir(output, { recursive: true });
const args = ['-app', '570', '-depot', values.depot!, '-manifest', values.manifest!, '-manifest-only', '-dir', output];
console.log('Anonymous Steam manifest-only probe: no account, credentials, or client payload download.');
const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
let timedOut = false;
let outputExceeded = false;
let killTimer: ReturnType<typeof setTimeout> | undefined;
function stop(): void {
  child.kill('SIGTERM');
  killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
}
function capture(chunk: Buffer): void {
  const text = chunk.toString('utf8');
  if (log.length + text.length > 1024 * 1024) { outputExceeded = true; stop(); return; }
  log += text;
  process.stdout.write(text);
}
child.stdout.on('data', capture);
child.stderr.on('data', capture);
const timer = setTimeout(() => { timedOut = true; stop(); }, 120_000);
let exitCode: number | null = null;
let signal: NodeJS.Signals | null = null;
let launchError: string | null = null;
try {
  await new Promise<void>(done => {
    child.once('error', error => { launchError = error.message; done(); });
    child.once('close', (code, sig) => { exitCode = code; signal = sig; done(); });
  });
} finally {
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
}
await writeFile(resolve(root, 'probe.log'), log);
const accessDenied = /not available from this account|access.?denied|insufficient.?privilege|no subscription/i.test(log);
const manifestFiles: string[] = [];
for (const file of await readdir(output, { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !file.name.includes(values.manifest!)) continue;
  const path = resolve(file.parentPath, file.name);
  if ((await stat(path)).size > 0) manifestFiles.push(relative(root, path));
}
// DepotDownloader can exit zero after an entitlement denial and download nothing.
const success = exitCode === 0 && !timedOut && !outputExceeded && launchError === null && !accessDenied && manifestFiles.length > 0;
await atomicJson(resolve(root, 'probe.json'), {
  attemptedAt: new Date().toISOString(), toolSha256: await sha256(tool),
  app: '570', depot: values.depot, manifest: values.manifest,
  mode: 'anonymous-manifest-only', timeoutSeconds: 120,
  exitCode, signal, timedOut, outputExceeded, launchError, accessDenied, manifestFiles, success,
  logPath: '.cache/terrain/probe.log',
  limitations: ['Manifest access alone does not establish replay map compatibility or terrain extraction. No client payload files are requested by this command.'],
});
if (!success) {
  console.error(`Manifest probe failed${accessDenied ? ' (Steam denied this depot to the anonymous account)' : ''}${timedOut ? ' (120-second timeout)' : ''}${launchError ? `: ${launchError}` : ''}${!manifestFiles.length ? ' (no manifest retrieved)' : ''}. Evidence saved to .cache/terrain/probe.json and probe.log.`);
  process.exitCode = 1;
} else console.log('Manifest retrieved. Inspect exact file paths and sizes before any bounded client-asset download.');
