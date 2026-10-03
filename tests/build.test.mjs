import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInstaller, satisfiesEngines, CONTRACT_URL, DEFAULT_SOURCE } from '../src/build.mjs';
import { makeZip } from './zip.mjs';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// A cc-shaped seed repo pushed to a bare origin.git (the build's --source),
// a fake makensis and a cached pinned node zip.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-build-'));
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  const pkg = (extra = {}) => fs.writeFileSync(path.join(seed, 'package.json'),
    JSON.stringify({ name: 'code-conductor', version: '3.2.1', engines: { node: '>=24' }, ...extra }) + '\n');
  pkg();
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(seed, 'LICENSE'), 'license text\n');
  fs.writeFileSync(path.join(seed, 'bin', 'windows-launch.mjs'), '// launcher\n');
  const commit = (msg) => {
    fs.appendFileSync(path.join(seed, 'f.txt'), `${msg}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', msg);
    return git(seed, 'rev-parse', 'HEAD');
  };
  commit('c1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const push = (...refs) => git(seed, 'push', '-q', origin, ...refs);
  push('main');

  // fake makensis: records argv; for installer.nsi snapshots the stage; writes OUTFILE.
  const record = path.join(root, 'calls.jsonl');
  const fake = path.join(root, 'makensis');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') process.exit(0);
const def = (n) => (argv.find((a) => a.startsWith('-D' + n + '=')) || '').slice(n.length + 3);
const stage = def('STAGE');
const entry = { argv };
if (stage) {
  const walk = (d, p = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), p + e.name + '/') : [p + e.name]);
  entry.files = walk(stage);
  entry.launcherExe = fs.existsSync(path.join(stage, 'code-conductor.exe'));
  entry.setup = fs.readFileSync(path.join(stage, 'setup.mjs'), 'utf8');
  entry.license = fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8');
  fs.cpSync(path.join(stage, 'cc.bundle'), ${JSON.stringify(path.join(root, 'seen.bundle'))});
}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(entry) + '\\n');
fs.writeFileSync(def('OUTFILE'), 'MZ fake');
`);
  fs.chmodSync(fake, 0o755);

  const zip = makeZip({ 'node-v24.21.0-win-x64/node.exe': 'NODEEXE', 'node-v24.21.0-win-x64/node_modules/npm/bin/npm-cli.js': '//npm' });
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir);
  fs.writeFileSync(path.join(cacheDir, 'node-v24.21.0-win-x64.zip'), zip);
  const pins = { node: { version: '24.21.0', url: 'https://example.invalid/node-v24.21.0-win-x64.zip', sha256: sha } };
  return {
    root, seed, origin, fake, zip, pins, cacheDir, outDir: path.join(root, 'out'), commit, push, pkg,
    calls: () => fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.argv[0] !== '--version'),
    ran: () => fs.existsSync(record),
    bundleTip: (branch) => {
      const clone = path.join(root, `clone-${crypto.randomUUID()}`);
      execFileSync('git', ['clone', '-q', '--branch', branch, path.join(root, 'seen.bundle'), clone]);
      return git(clone, 'rev-parse', 'HEAD');
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const opts = (t, extra = {}) => ({
  source: t.origin, outDir: t.outDir, cacheDir: t.cacheDir, pins: t.pins, makensis: t.fake,
  log: () => {}, download: async () => assert.fail('cache should satisfy the pin'), ...extra,
});
const defines = (call) => Object.fromEntries(call.argv.filter((a) => a.startsWith('-D')).map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));

test('happy path: bundle carries the resolved commit on the branch; stage has node/, LICENSE from the ref, this repo\'s setup.mjs; defines passed; launcher before installer', async () => {
  const t = setup();
  try {
    const head = git(t.seed, 'rev-parse', 'HEAD');
    const r = await buildInstaller(opts(t));
    assert.equal(r.commit, head);
    assert.equal(r.outFile, path.join(t.outDir, `code-conductor-setup-3.2.1-${head.slice(0, 8)}.exe`));
    assert.ok(fs.existsSync(r.outFile));

    const [launcher, installer] = t.calls();
    assert.match(launcher.argv.at(-1), /launcher\.nsi$/);
    assert.equal(defines(launcher).LAUNCHER, 'bin\\windows-launch.mjs');
    assert.match(installer.argv.at(-1), /installer\.nsi$/);
    const defs = defines(installer);
    assert.equal(defs.VERSION, '3.2.1');
    assert.equal(defs.COMMIT, head.slice(0, 8));
    assert.equal(defs.BRANCH, 'main');
    assert.equal(defs.REMOTE_URL, DEFAULT_SOURCE, 'origin is the GitHub default, not the build source');
    assert.equal(defs.LAUNCHER, 'bin\\windows-launch.mjs');
    assert.equal(defs.OUTFILE, r.outFile);

    for (const f of ['LICENSE', 'node/node.exe', 'node/node_modules/npm/bin/npm-cli.js', 'installer.nsi', 'launcher.nsi', 'setup.mjs', 'toolchain.mjs', 'pins.json', 'cc.bundle']) {
      assert.ok(installer.files.includes(f), f);
    }
    assert.equal(installer.license, 'license text\n', 'LICENSE comes from the cc ref');
    assert.equal(installer.setup, fs.readFileSync(path.join(srcDir, 'setup.mjs'), 'utf8'), 'setup.mjs comes from this repo');
    assert.equal(installer.launcherExe, true);
    assert.equal(t.bundleTip('main'), head);
  } finally { t.cleanup(); }
});

test('--ref as a tag and as a sha each resolve; --branch names the bundled branch', async () => {
  const t = setup();
  try {
    const c1 = git(t.seed, 'rev-parse', 'HEAD');
    git(t.seed, 'tag', 'v0.2.0');
    t.push('v0.2.0');
    t.commit('c2');
    t.push('main');
    const r = await buildInstaller(opts(t, { ref: 'v0.2.0' }));
    assert.equal(r.commit, c1);
    assert.equal(t.bundleTip('main'), c1);

    const r2 = await buildInstaller(opts(t, { ref: c1, branch: 'stable' }));
    assert.equal(r2.commit, c1);
    assert.equal(defines(t.calls().at(-1)).BRANCH, 'stable');
    assert.equal(t.bundleTip('stable'), c1);
  } finally { t.cleanup(); }
});

test('an unknown ref is refused before makensis runs', async () => {
  const t = setup();
  try {
    await assert.rejects(buildInstaller(opts(t, { ref: 'no-such-ref' })), /ref "no-such-ref" is not a branch, tag or commit/);
    assert.equal(t.ran(), false);
  } finally { t.cleanup(); }
});

test('a ref without bin/windows-launch.mjs is refused, citing the contract', async () => {
  const t = setup();
  try {
    git(t.seed, 'rm', '-q', 'bin/windows-launch.mjs');
    t.commit('drop launcher');
    t.push('main');
    const err = await buildInstaller(opts(t)).then(() => assert.fail('built'), (e) => e);
    assert.match(err.message, /bin\/windows-launch\.mjs is missing/);
    assert.ok(err.message.includes(CONTRACT_URL));
    assert.equal(t.ran(), false);
  } finally { t.cleanup(); }
});

test('engines.node the pinned Node does not satisfy, or in an unreadable form, is refused', async () => {
  for (const [node, re] of [['>=99', /pinned Node 24\.21\.0 does not satisfy engines\.node ">=99"/], ['^24', /not of the form >=N\[\.N\[\.N\]\]/]]) {
    const t = setup();
    try {
      t.pkg({ engines: { node } });
      t.commit('engines');
      t.push('main');
      const err = await buildInstaller(opts(t)).then(() => assert.fail('built'), (e) => e);
      assert.match(err.message, re);
      assert.ok(err.message.includes(CONTRACT_URL));
    } finally { t.cleanup(); }
  }
});

test('a commit off the branch warns that self-update will report ahead or diverged', async () => {
  const t = setup();
  try {
    git(t.seed, 'checkout', '-q', '-b', 'feature');
    t.commit('f1');
    t.push('feature');
    const lines = [];
    await buildInstaller(opts(t, { ref: 'feature', log: (m) => lines.push(m) }));
    assert.ok(lines.some((l) => /warning: .* not contained in main/.test(l)), lines.join('\n'));
    const quiet = [];
    await buildInstaller(opts(t, { log: (m) => quiet.push(m) }));
    assert.equal(quiet.some((l) => /warning/.test(l)), false);
  } finally { t.cleanup(); }
});

test('a cached zip with the wrong sha is re-downloaded; a download that still mismatches is refused', async () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.cacheDir, 'node-v24.21.0-win-x64.zip'), 'corrupt');
    await assert.rejects(buildInstaller(opts(t, {
      download: async (url, dest) => fs.writeFileSync(dest, 'tampered'),
    })), /sha256 mismatch/);
    assert.equal(fs.existsSync(path.join(t.cacheDir, 'node-v24.21.0-win-x64.zip')), false);
    assert.equal(t.ran(), false, 'makensis never ran');

    const r = await buildInstaller(opts(t, { download: async (url, dest) => fs.writeFileSync(dest, t.zip) }));
    assert.ok(fs.existsSync(r.outFile));
  } finally { t.cleanup(); }
});

test('satisfiesEngines: >=N[.N[.N]] compared numerically; other forms unreadable', () => {
  assert.equal(satisfiesEngines('24.21.0', '>=24'), true);
  assert.equal(satisfiesEngines('24.21.0', '>= 24.21'), true);
  assert.equal(satisfiesEngines('24.21.0', '>=24.21.1'), false);
  assert.equal(satisfiesEngines('24.9.0', '>=24.10'), false);
  assert.equal(satisfiesEngines('25.0.0', '>=24.99.99'), true);
  assert.equal(satisfiesEngines('24.21.0', '^24'), null);
});
