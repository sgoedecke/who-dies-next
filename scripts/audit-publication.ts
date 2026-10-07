import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogSchema, scenarioSchema } from '../shared/scenario.js';
import { scenarioEligibility } from '../shared/recent.js';

const rootFiles = new Set([
  '.gitignore', 'README.md', 'SCRAPE.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE',
  'index.html', 'package.json', 'package-lock.json', 'tsconfig.json',
  'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts',
]);
const publicPath = (path: string) => /^(assets\/(?:.+\.png|manifest\.json|catalog\/[a-z_]+\.json)|maps\/dota-\d+\.json|scenarios\/(?:index|corpus-report|replay-\d+-\d+)\.json|THIRD_PARTY_NOTICES\.md)$/.test(path);
const repositoryPath = (path: string) => rootFiles.has(path)
  || /^\.github\/workflows\/[a-z-]+\.yml$/.test(path)
  || /^(src|shared|ingestion|scripts|tests)\/[A-Za-z0-9_./-]+\.(ts|tsx|css)$/.test(path)
  || /^docs\/[a-z-]+\.md$/.test(path)
  || /^worker\/(?:README\.md|pom\.xml|(?:build|run|runtime)\.sh|verify-output\.py|src\/[A-Za-z0-9_/]+\.java)$/.test(path)
  || (path.startsWith('public/') && publicPath(path.slice(7)));
const sensitiveText = [
  /\/Users\/[^\s"'`]+/,
  /\.copilot\/session-state\//,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{50,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function inspect(path: string, bytes: Buffer) {
  if (bytes.length > 5 * 1024 ** 2) throw new Error(`Unexpected large publication file: ${path}`);
  if (path.endsWith('.png')) {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Invalid PNG: ${path}`);
    return;
  }
  const text = bytes.toString('utf8');
  if (sensitiveText.some(pattern => pattern.test(text))) throw new Error(`Sensitive credential/private-path pattern in ${path}; content withheld`);
  if ((path.startsWith('public/') || path.startsWith('scenarios/')) && path.endsWith('.json')) {
    if (/"(?:steam_?id|account_id|personaname|player_name|password|access_token|refresh_token)"\s*:/i.test(text)) {
      throw new Error(`Private data field in ${path}; content withheld`);
    }
  }
}

async function walk(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(join(directory, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(directory, path));
    if (stat.isSymbolicLink()) throw new Error(`Publication symlink refused: ${path}`);
    if (stat.isDirectory()) files.push(...await walk(directory, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`Unsupported publication entry: ${path}`);
  }
  return files;
}

function checkCorpus(files: Map<string, Buffer>, prefix: string) {
  const index = files.get(`${prefix}scenarios/index.json`);
  if (!index) throw new Error('Publication has no scenario catalog');
  const catalog = catalogSchema.parse(JSON.parse(index.toString('utf8')));
  if (catalog.scenarios.length !== 50) throw new Error('Publication must preserve exactly 50 real snippets');
  const actual = [...files.keys()].filter(path => path.startsWith(`${prefix}scenarios/replay-`));
  if (actual.length !== 50) throw new Error('Publication has missing or extra snippet files');
  const ids = new Set<string>(), matches = new Map<string, number>();
  for (const entry of catalog.scenarios) {
    if (entry.path !== `/scenarios/${entry.id}.json` || ids.has(entry.id)) throw new Error('Invalid or duplicate catalog identity');
    ids.add(entry.id);
    const bytes = files.get(`${prefix}${entry.path.slice(1)}`);
    if (!bytes) throw new Error(`Missing published snippet: ${entry.id}`);
    const scenario = scenarioSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (scenario.id !== entry.id || !scenarioEligibility(scenario).eligible || !scenario.source.matchId
      || /TEST ONLY/i.test(scenario.source.label)) throw new Error(`Nonpublishable source: ${entry.id}`);
    matches.set(scenario.source.matchId, (matches.get(scenario.source.matchId) ?? 0) + 1);
  }
  if ([...matches.values()].some(count => count > 5)) throw new Error('Publication exceeds five snippets per match');
}

const names = execFileSync('git', ['ls-files', '--cached', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!names.length) throw new Error('No staged/tracked files to audit');
const tracked = new Map<string, Buffer>();
for (const path of names) {
  if (!repositoryPath(path) || path.split('/').includes('..')) throw new Error(`File outside publication allowlist: ${path}`);
  const mode = execFileSync('git', ['ls-files', '--stage', '--', path], { encoding: 'utf8' }).slice(0, 6);
  if (mode !== '100644' && mode !== '100755') throw new Error(`Unsupported git file mode: ${path}`);
  const size = Number(execFileSync('git', ['cat-file', '-s', `:${path}`], { encoding: 'utf8' }));
  if (!Number.isSafeInteger(size) || size > 5 * 1024 ** 2) throw new Error(`Unexpected large publication file: ${path}`);
  const bytes = execFileSync('git', ['show', `:${path}`], { maxBuffer: 6 * 1024 ** 2 });
  inspect(path, bytes);
  tracked.set(path, bytes);
}
checkCorpus(tracked, 'public/');
if (!tracked.has('src/App.tsx')) throw new Error('Release must contain the app source');
if (!tracked.get('THIRD_PARTY_NOTICES.md')?.equals(tracked.get('public/THIRD_PARTY_NOTICES.md') ?? Buffer.alloc(0))) {
  throw new Error('Repository and deployed attribution notices must match');
}
const built = new Map<string, Buffer>();
for (const path of await walk('dist')) {
  if (!(path === 'index.html' || /^assets\/index-[A-Za-z0-9_-]+\.(js|css)$/.test(path) || publicPath(path))) throw new Error(`File outside deploy allowlist: ${path}`);
  const bytes = await readFile(join('dist', path));
  inspect(path, bytes);
  built.set(path, bytes);
  if (publicPath(path) && !tracked.get(`public/${path}`)?.equals(bytes)) throw new Error(`Built public artifact differs from audited git index: ${path}`);
}
checkCorpus(built, '');
console.log(`Publication audit passed: ${tracked.size} tracked files; ${built.size} deployment files; exactly 50 real snippets; no denied artifacts or detected private data.`);
