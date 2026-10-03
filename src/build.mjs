// Builds the per-user Windows installer on Linux from a chosen cc source and ref:
//   npm run build -- [--source URL|PATH] [--ref REF] [--branch B] [--remote-url URL]
// Env: MAKENSIS (default makensis). Reproducible in its inputs (pinned node +
// the resolved cc commit + this repo's sources), not byte-identical.
// What a cc ref must provide: CONTRACT_URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULT_SOURCE = 'https://github.com/UnmanagedCode/code-conductor.git';
export const CONTRACT_URL = 'https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract';
// The launcher inside the checkout (contract C4); the stub and the
// installer's StopRunning get it as the LAUNCHER define.
export const LAUNCHER_REL = 'bin/windows-launch.mjs';
const ENGINES_RE = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
// This repo's files that ship inside the installer.
const SHIPPED = ['setup.mjs', 'toolchain.mjs', 'pins.json', 'installer.nsi', 'launcher.nsi'];
const srcDir = path.dirname(fileURLToPath(import.meta.url));

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(cmd, args, { cwd, input, allowFail, encoding = 'utf8' } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding, maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return r;
}

async function defaultDownload(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url} failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The pinned zip, from cache when its sha matches, else downloaded; refuses
// anything whose sha256 is not the pin.
async function fetchPinned(pin, cacheDir, download, log) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, path.basename(new URL(pin.url).pathname));
  if (fs.existsSync(file) && sha256(file) === pin.sha256) {
    log(`node: using cached ${file}`);
    return file;
  }
  log(`node: downloading ${pin.url}`);
  await download(pin.url, file);
  const got = sha256(file);
  if (got !== pin.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`sha256 mismatch for ${pin.url}: got ${got}, pinned ${pin.sha256}`);
  }
  return file;
}

const versionParts = (v) => v.split('.').map(Number);

// Whether `version` (N.N.N) satisfies `range` (>=N[.N[.N]]); null when the
// range is not of that form.
export function satisfiesEngines(version, range) {
  const m = ENGINES_RE.exec(range);
  if (!m) return null;
  const want = [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number);
  const have = versionParts(version);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  }
  return true;
}

// The contract checks a cc commit must pass before it is bundled. Returns
// {version} or throws listing every failed check.
function checkContract(git, commit, nodeVersion) {
  const problems = [];
  for (const f of [LAUNCHER_REL, 'package.json', 'package-lock.json', 'LICENSE']) {
    if (git(['cat-file', '-e', `${commit}:${f}`], { allowFail: true }).status !== 0) problems.push(`${f} is missing`);
  }
  let pkg = {};
  const shown = git(['show', `${commit}:package.json`], { allowFail: true });
  if (shown.status === 0) {
    try { pkg = JSON.parse(shown.stdout); } catch (e) { problems.push(`package.json does not parse: ${e.message}`); }
  }
  if (typeof pkg.version !== 'string') problems.push('package.json has no string "version"');
  const range = pkg.engines?.node;
  const ok = typeof range === 'string' ? satisfiesEngines(nodeVersion, range) : null;
  if (ok === null) problems.push(`package.json engines.node ${JSON.stringify(range)} is not of the form >=N[.N[.N]]`);
  else if (!ok) problems.push(`the pinned Node ${nodeVersion} does not satisfy engines.node "${range}"`);
  if (problems.length) {
    throw new Error(`cc commit ${commit.slice(0, 8)} does not meet the installer contract (${CONTRACT_URL}):\n  - ${problems.join('\n  - ')}`);
  }
  return { version: pkg.version };
}

export async function buildInstaller({
  source = DEFAULT_SOURCE, ref = 'main', branch = 'main', remoteUrl = DEFAULT_SOURCE,
  outDir, cacheDir, pins, makensis = 'makensis', log = console.log, download = defaultDownload, stageDir,
}) {
  for (const tool of [makensis, 'git', 'unzip', 'tar']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') {
      throw new Error(`${tool} not found${tool === makensis ? ' (sudo apt install nsis)' : ''}`);
    }
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-build-'));
  try {
    const bare = path.join(work, 'cc.git');
    run('git', ['init', '-q', '--bare', bare]);
    const git = (args, opts) => run('git', ['-C', bare, ...args], opts);
    log(`cc: fetching ${source}`);
    // A local path is relative to the caller's cwd, not the temp repo's.
    git(['fetch', '-q', fs.existsSync(source) ? path.resolve(source) : source,'+refs/heads/*:refs/remotes/src/*', '+refs/tags/*:refs/tags/*']);

    const resolve = (r) => {
      const res = git(['rev-parse', '--verify', '-q', `${r}^{commit}`], { allowFail: true });
      return res.status === 0 ? res.stdout.trim() : null;
    };
    const commit = resolve(`refs/remotes/src/${ref}`) ?? resolve(`refs/tags/${ref}`) ?? resolve(ref);
    if (!commit) throw new Error(`ref ${JSON.stringify(ref)} is not a branch, tag or commit in ${source}`);
    const short = commit.slice(0, 8);
    log(`cc: ${ref} is ${commit}`);
    const { version } = checkContract(git, commit, pins.node.version);
    log(`cc: contract checks passed (${LAUNCHER_REL}, package.json version ${version}, engines.node, package-lock.json, LICENSE)`);

    const branchRef = `refs/remotes/src/${branch}`;
    if (resolve(branchRef) && git(['merge-base', '--is-ancestor', commit, branchRef], { allowFail: true }).status !== 0) {
      log(`warning: ${short} is not contained in ${branch} at the source; the installed checkout will report ahead or diverged in self-update until the commit is on ${branch}`);
    }

    const stage = stageDir ?? path.join(work, 'stage');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });

    git(['update-ref', `refs/heads/${branch}`, commit]);
    const bundle = path.join(stage, 'cc.bundle');
    git(['bundle', 'create', '-q', bundle, `refs/heads/${branch}`]);
    git(['bundle', 'verify', '-q', bundle]);
    fs.writeFileSync(path.join(stage, 'LICENSE'), git(['show', `${commit}:LICENSE`], { encoding: 'buffer' }).stdout);
    for (const f of SHIPPED) fs.copyFileSync(path.join(srcDir, f), path.join(stage, f));

    const zip = await fetchPinned(pins.node, cacheDir, download, log);
    const extract = path.join(work, 'node-extract');
    run('unzip', ['-q', zip, '-d', extract]);
    const top = fs.readdirSync(extract);
    const root = top.length === 1 && fs.statSync(path.join(extract, top[0])).isDirectory()
      ? path.join(extract, top[0]) : extract;
    fs.renameSync(root, path.join(stage, 'node'));

    const launcher = `-DLAUNCHER=${LAUNCHER_REL.replaceAll('/', '\\')}`;
    run(makensis, ['-V2', `-DOUTFILE=${path.join(stage, 'code-conductor.exe')}`, launcher, path.join(stage, 'launcher.nsi')]);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `code-conductor-setup-${version}-${short}.exe`);
    run(makensis, [
      '-V2', `-DVERSION=${version}`, `-DCOMMIT=${short}`, `-DBRANCH=${branch}`,
      `-DREMOTE_URL=${remoteUrl}`, `-DSTAGE=${stage}`, `-DOUTFILE=${outFile}`, launcher,
      path.join(stage, 'installer.nsi'),
    ]);
    if (!fs.existsSync(outFile)) throw new Error(`makensis did not produce ${outFile}`);
    log(`built ${outFile}`);
    return { outFile, version, commit };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoDir = path.resolve(srcDir, '..');
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: DEFAULT_SOURCE },
      ref: { type: 'string', default: 'main' },
      branch: { type: 'string', default: 'main' },
      'remote-url': { type: 'string', default: DEFAULT_SOURCE },
    },
  });
  buildInstaller({
    source: values.source,
    ref: values.ref,
    branch: values.branch,
    remoteUrl: values['remote-url'],
    outDir: path.join(repoDir, 'build'),
    cacheDir: path.join(repoDir, 'build', 'cache'),
    pins: JSON.parse(fs.readFileSync(path.join(srcDir, 'pins.json'), 'utf8')),
    makensis: process.env.MAKENSIS || 'makensis',
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
