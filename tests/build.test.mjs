import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller, DEFAULT_SOURCE } from '../src/build.mjs';
import { makeZip } from './zip.mjs';

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoDir, 'src');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version;

// A fake makensis that records argv; for installer.nsi it snapshots the
// stage; it writes OUTFILE. Plus a cached pinned node zip.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-build-'));
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
  entry.license = fs.readFileSync(path.join(stage, 'LICENSE'), 'utf8');
  entry.icon = fs.existsSync(def('ICON'));
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
    root, fake, zip, pins, cacheDir, outDir: path.join(root, 'out'),
    calls: () => fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.argv[0] !== '--version'),
    ran: () => fs.existsSync(record),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const opts = (t, extra = {}) => ({
  outDir: t.outDir, cacheDir: t.cacheDir, pins: t.pins, makensis: t.fake,
  log: () => {}, download: async () => assert.fail('cache should satisfy the pin'), ...extra,
});
const defines = (call) => Object.fromEntries(call.argv.filter((a) => a.startsWith('-D')).map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));

// Invariant: the installer is not tied to a cc commit: the exe is named by
// this repo's version, the defines carry the GitHub source and main (and the
// icon), none carries a commit sha, and the launcher is built before the installer.
test('default build: exe named by the package version; defines have source/branch/icon and no commit', async () => {
  const t = setup();
  try {
    const r = await buildInstaller(opts(t));
    assert.equal(r.version, pkgVersion);
    assert.equal(r.outFile, path.join(t.outDir, `code-conductor-setup-${pkgVersion}.exe`));
    assert.ok(fs.existsSync(r.outFile));

    const [launcher, installer] = t.calls();
    assert.match(launcher.argv.at(-1), /launcher\.nsi$/);
    assert.equal(defines(launcher).LAUNCHER, 'bin\\windows-launch.mjs');
    assert.match(installer.argv.at(-1), /installer\.nsi$/);
    const defs = defines(installer);
    assert.deepEqual(Object.keys(defs).sort(), ['BRANCH', 'ICON', 'LAUNCHER', 'OUTFILE', 'SOURCE', 'STAGE', 'VERSION']);
    assert.equal(defs.VERSION, pkgVersion);
    assert.equal(defs.SOURCE, DEFAULT_SOURCE);
    assert.equal(defs.BRANCH, 'main');
    assert.equal(defs.LAUNCHER, 'bin\\windows-launch.mjs');
    assert.equal(defs.OUTFILE, r.outFile);
    for (const [k, v] of Object.entries(defs)) {
      if (k !== 'STAGE' && k !== 'OUTFILE') assert.doesNotMatch(v, /[0-9a-f]{8,}/, `${k} carries a sha-like value`);
    }
    assert.match(path.basename(r.outFile), /^code-conductor-setup-[\d.]+\.exe$/);
  } finally { t.cleanup(); }
});

// Invariant: the stage holds exactly what the installer embeds (every
// shipped source file, the repo LICENSE, the icon, node/) and no cc bundle;
// both makensis runs get the staged icon.
test('stage: shipped files, repo LICENSE, icon and node/, no cc.bundle; both makensis runs get ICON', async () => {
  const t = setup();
  try {
    await buildInstaller(opts(t));
    const [launcher, installer] = t.calls();
    for (const f of ['setup.mjs', 'toolchain.mjs', 'contract.mjs', 'projects.mjs', 'port.mjs', 'port.nsh', 'pins.json', 'installer.nsi', 'launcher.nsi', 'icon.ico', 'LICENSE', 'node/node.exe', 'node/node_modules/npm/bin/npm-cli.js']) {
      assert.ok(installer.files.includes(f), f);
    }
    assert.equal(installer.files.includes('cc.bundle'), false);
    assert.equal(installer.license, fs.readFileSync(path.join(repoDir, 'LICENSE'), 'utf8'));
    assert.equal(installer.launcherExe, true);
    assert.equal(defines(launcher).ICON, defines(installer).ICON);
    assert.match(defines(installer).ICON, /icon\.ico$/);
    assert.equal(installer.icon, true);
  } finally { t.cleanup(); }
});

// Invariant: --source/--branch overrides reach the defines unchanged.
test('--source and --branch overrides are baked in as SOURCE and BRANCH', async () => {
  const t = setup();
  try {
    const lines = [];
    await buildInstaller(opts(t, { source: '/tmp/cc-checkout', branch: 'stable', log: (m) => lines.push(m) }));
    const defs = defines(t.calls().at(-1));
    assert.equal(defs.SOURCE, '/tmp/cc-checkout');
    assert.equal(defs.BRANCH, 'stable');
    assert.ok(lines.some((l) => l.includes('stable from /tmp/cc-checkout')), lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: a source or branch that would break the makensis command line
// (empty, a double quote, whitespace) is refused before makensis runs.
test('a quote, whitespace or empty source/branch is refused before makensis runs', async () => {
  const t = setup();
  try {
    for (const bad of [{ source: 'a b' }, { source: 'a"b' }, { source: '' }, { branch: 'x y' }, { branch: 'x"' }, { branch: '' }]) {
      await assert.rejects(buildInstaller(opts(t, bad)), /must be non-empty and contain no whitespace or double quote/, JSON.stringify(bad));
    }
    assert.equal(t.ran(), false);
  } finally { t.cleanup(); }
});

// Invariant: a cached pinned zip with the wrong sha is re-downloaded and a
// download that still mismatches is refused, before makensis runs.
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

// Invariant: src/icon.ico is a real multi-size ICO (reserved 0, type 1) that
// carries the sizes Windows asks for: 16, 32, 48 and 256 px (width byte 0).
test('src/icon.ico parses as an ICO with 16, 32, 48 and 256 px entries', () => {
  const ico = fs.readFileSync(path.join(srcDir, 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const widths = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256);
  for (const w of [16, 32, 48, 256]) assert.ok(widths.includes(w), `${w}px in ${widths}`);
});
