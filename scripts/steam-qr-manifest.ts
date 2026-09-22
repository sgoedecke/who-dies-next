import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { atomicJson, exists } from '../ingestion/files.js';
import { MAP_DEPOT, MAP_MANIFEST, selectCurrentMapFiles } from '../ingestion/map-assets.js';

const { values } = parseArgs({ options: {
  check: { type: 'boolean', default: false },
  'download-map': { type: 'boolean', default: false },
} });
const root = resolve('.cache/terrain');
const tool = resolve('.tools/depot-downloader/DepotDownloader');
const output = join(root, values['download-map'] ? 'current-client' : 'authenticated-manifest');
const selected = values['download-map']
  ? selectCurrentMapFiles(await readFile(join(root, 'authenticated-manifest', `manifest_${MAP_DEPOT}_${MAP_MANIFEST}.txt`), 'utf8'))
  : [];
const statusPath = join(root, 'qr-status.json');
if (process.platform !== 'darwin') throw new Error('This credential-isolation wrapper is verified for macOS only.');
if (!await exists(tool)) throw new Error('Project-local DepotDownloader is not installed.');
process.umask(0o077);
await mkdir(root, { recursive: true });
const lockPath = join(root, 'qr-auth.lock');
const lock = await open(lockPath, 'wx');
await lock.writeFile(String(process.pid));
const profile = await mkdtemp(join(root, 'steam-auth-'));
await chmod(profile, 0o700);
const env = {
  ...process.env,
  HOME: profile,
  // macOS .NET uses Foundation's application-support directory, not HOME/XDG alone.
  CFFIXED_USER_HOME: profile,
  XDG_DATA_HOME: join(profile, 'data'),
  XDG_CONFIG_HOME: join(profile, 'config'),
  DOTNET_CLI_HOME: profile,
};
let child: ChildProcess | null = null;
let cancelled = false;
let timedOut = false;
let killTimer: ReturnType<typeof setTimeout> | undefined;
function stop(): void {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  killTimer ??= setTimeout(() => child?.kill('SIGKILL'), 5000);
}
function cancel(): void { cancelled = true; stop(); }
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
async function run(args: string[], timeoutMs: number, visible: boolean): Promise<number | null> {
  child = spawn(tool, args, { cwd: profile, env, stdio: ['ignore', visible ? 'inherit' : 'ignore', visible ? 'inherit' : 'ignore'] });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  try {
    return await new Promise<number | null>((done, reject) => {
      child!.once('error', reject);
      child!.once('close', done);
    });
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    killTimer = undefined;
    child = null;
  }
}
const state: Record<string, unknown> = {
  pid: process.pid, purpose: values.check ? 'isolation-check-only' : values['download-map'] ? 'user-approved-qr-exact-map-files' : 'user-approved-qr-manifest-only',
  phase: 'checking-isolation', startedAt: new Date().toISOString(), profilePath: profile,
  isolationVerified: false, cleanupVerified: false, manifestFiles: [], selectedFiles: selected,
};
try {
  await atomicJson(statusPath, state);
  const checkExit = await run(['-V'], 30_000, false);
  if (checkExit !== 0 || cancelled || timedOut) throw new Error('Non-authenticating storage preflight failed.');
  const storage = join(profile, 'Library', 'Application Support', 'IsolatedStorage');
  const stores = (await readdir(storage, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name === 'AssemFiles');
  if (!stores.length) throw new Error('Actual .NET isolated storage was not created inside the private profile; authentication refused.');
  state.isolationVerified = true;
  if (values.check) {
    await writeFile(join(stores[0].parentPath, stores[0].name, '.dotadle-cleanup-check'), 'nonsecret cleanup test\n');
    state.phase = 'isolation-check-complete';
  } else {
    await mkdir(output, { recursive: true });
    state.phase = 'awaiting-user-qr-approval';
    await atomicJson(statusPath, state);
    console.log('Scan the QR below with the Steam Mobile app and approve DepotDownloader there.');
    console.log('Do NOT type a password or Steam Guard code here. This workflow accepts QR approval only.');
    console.log(values['download-map']
      ? `Only three exact current-map/build files will be fetched (${selected.reduce((sum, f) => sum + f.size, 0)} bytes maximum on disk); no full depot installation.`
      : 'Only the requested manifest will be fetched; no game files or full depot installation.');
    console.log('Temporary login data is confined to a private profile and removed when this process exits normally or is cancelled.');
    console.log('Terminal text/history can persist. Hard-kill/power loss can interrupt cleanup; the private profile path is recorded in .cache/terrain/qr-status.json.');
    console.log('Ctrl-C cancels. This QR session expires after ten minutes. No auth output is captured by the wrapper.');
    const fileList = join(profile, 'exact-map-files.txt');
    if (values['download-map']) {
      const contents = selected.map(file => file.path).join('\n') + '\n';
      await writeFile(fileList, contents, { flag: 'wx', mode: 0o600 });
      if (await readFile(fileList, 'utf8') !== contents) throw new Error('Exact map file list is not readable; download refused');
    }
    const code = await run([
      '-app', '570', '-depot', MAP_DEPOT, '-manifest', MAP_MANIFEST,
      ...(values['download-map'] ? ['-filelist', fileList, '-max-downloads', '4', '-validate'] : ['-manifest-only']),
      '-qr', '-loginid', String(process.pid), '-dir', output,
    ], 600_000, true);
    const files = (await readdir(output, { recursive: true, withFileTypes: true }))
      .filter(file => file.isFile() && file.name.includes(MAP_MANIFEST))
      .map(file => join(file.parentPath, file.name));
    state.manifestFiles = files;
    state.exitCode = code;
    if (values['download-map'] && code === 0 && !cancelled && !timedOut) {
      for (const file of selected) {
        const path = join(output, file.path);
        if ((await stat(path)).size !== file.size) throw new Error(`Downloaded size mismatch: ${file.path}`);
        const hash = createHash('sha1');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        if (hash.digest('hex') !== file.sha1) throw new Error(`Downloaded manifest checksum mismatch: ${file.path}`);
      }
      state.phase = 'map-files-ready';
    } else state.phase = cancelled ? 'cancelled' : timedOut ? 'timed-out' : code === 0 && files.length > 0 ? 'manifest-ready' : 'failed';
    if (!['manifest-ready', 'map-files-ready'].includes(String(state.phase))) process.exitCode = 1;
  }
} catch (error) {
  state.phase = 'failed';
  state.error = error instanceof Error ? error.message : String(error);
  console.error(state.error);
  process.exitCode = 1;
} finally {
  if (resolve(profile) !== profile || !profile.startsWith(`${root}/steam-auth-`) || !basename(profile).startsWith('steam-auth-')) {
    throw new Error('Refusing cleanup outside the explicitly created private auth profile');
  }
  // This newly-created private subtree is ours; never inspect credential contents.
  await rm(profile, { recursive: true, force: true });
  state.cleanupVerified = !await exists(profile);
  state.completedAt = new Date().toISOString();
  await atomicJson(statusPath, state);
  await lock.close();
  await rm(lockPath, { force: true });
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  console.log(`Private credential profile removed: ${state.cleanupVerified ? 'yes' : 'NO'}. Status: ${state.phase}.`);
}
