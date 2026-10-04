// Builds the per-user Windows installer on Linux. The installer is not tied
// to a cc commit: it clones cc's latest <branch> from <source> at install time.
//   npm run build -- [--source URL|PATH] [--branch B]
// --source/--branch are baked in as the install-time defaults (for test builds).
// Env: MAKENSIS (default makensis). Reproducible in its inputs (pinned node +
// this repo's sources), not byte-identical.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { LAUNCHER_REL } from './contract.mjs';

export const DEFAULT_SOURCE = 'https://github.com/UnmanagedCode/code-conductor.git';
// This repo's files that ship inside the installer.
const SHIPPED = ['setup.mjs', 'toolchain.mjs', 'contract.mjs', 'projects.mjs', 'port.mjs', 'port.nsh', 'pins.json', 'installer.nsi', 'launcher.nsi', 'icon.ico'];
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(srcDir, '..');

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

export async function buildInstaller({
  source = DEFAULT_SOURCE, branch = 'main',
  outDir, cacheDir, pins, makensis = 'makensis', log = console.log, download = defaultDownload, stageDir,
}) {
  for (const tool of [makensis, 'unzip']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') {
      throw new Error(`${tool} not found${tool === makensis ? ' (sudo apt install nsis)' : ''}`);
    }
  }
  // Both reach the makensis command line as -D defines.
  for (const [name, value] of [['source', source], ['branch', branch]]) {
    if (!value || /["\s]/.test(value)) throw new Error(`--${name} must be non-empty and contain no whitespace or double quote: ${JSON.stringify(value)}`);
  }
  if (source !== DEFAULT_SOURCE || branch !== 'main') log(`install-time defaults baked in: ${branch} from ${source}`);
  const { version } = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-build-'));
  try {
    const stage = stageDir ?? path.join(work, 'stage');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.copyFileSync(path.join(repoDir, 'LICENSE'), path.join(stage, 'LICENSE'));
    for (const f of SHIPPED) fs.copyFileSync(path.join(srcDir, f), path.join(stage, f));

    const zip = await fetchPinned(pins.node, cacheDir, download, log);
    const extract = path.join(work, 'node-extract');
    run('unzip', ['-q', zip, '-d', extract]);
    const top = fs.readdirSync(extract);
    const root = top.length === 1 && fs.statSync(path.join(extract, top[0])).isDirectory()
      ? path.join(extract, top[0]) : extract;
    fs.renameSync(root, path.join(stage, 'node'));

    const launcher = `-DLAUNCHER=${LAUNCHER_REL.replaceAll('/', '\\')}`;
    const icon = `-DICON=${path.join(stage, 'icon.ico')}`;
    run(makensis, ['-V2', `-DOUTFILE=${path.join(stage, 'code-conductor.exe')}`, launcher, icon, path.join(stage, 'launcher.nsi')]);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `code-conductor-setup-${version}.exe`);
    run(makensis, [
      '-V2', `-DVERSION=${version}`, `-DSOURCE=${source}`, `-DBRANCH=${branch}`,
      `-DSTAGE=${stage}`, `-DOUTFILE=${outFile}`, launcher, icon,
      path.join(stage, 'installer.nsi'),
    ]);
    if (!fs.existsSync(outFile)) throw new Error(`makensis did not produce ${outFile}`);
    log(`built ${outFile}`);
    return { outFile, version };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      source: { type: 'string', default: DEFAULT_SOURCE },
      branch: { type: 'string', default: 'main' },
    },
  });
  buildInstaller({
    source: values.source,
    branch: values.branch,
    outDir: path.join(repoDir, 'build'),
    cacheDir: path.join(repoDir, 'build', 'cache'),
    pins: JSON.parse(fs.readFileSync(path.join(srcDir, 'pins.json'), 'utf8')),
    makensis: process.env.MAKENSIS || 'makensis',
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
