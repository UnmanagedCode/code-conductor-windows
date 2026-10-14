// Real fetch: the current cc main on GitHub meets the installer contract with
// the pinned Node, as install time will check it (the build no longer does).
//   RUN_REAL_CC_FETCH=1 node --test tests/checkout.real.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkout, installDeps } from '../src/setup.mjs';
import { DEFAULT_SOURCE } from '../src/build.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = process.env.RUN_REAL_CC_FETCH ? test : test.skip.bind(test);

// Invariant: a fresh checkout() of the real DEFAULT_SOURCE main succeeds, so
// cc main passes the contract (launcher, package.json without root install
// lifecycle scripts, engines.node) against the Node this installer pins.
t('cc main from GitHub passes the install-time contract with the pinned Node', { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-fetch-'));
  try {
    const pins = JSON.parse(fs.readFileSync(path.join(repoDir, 'src', 'pins.json'), 'utf8'));
    const r = await checkout({
      git: 'git', source: DEFAULT_SOURCE, dir: path.join(dir, 'app'), branch: 'main',
      nodeVersion: pins.node.version, log: console.log, env: process.env,
    });
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.equal(typeof r.version, 'string');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Invariant: after a real checkout() of cc main, installDeps (npm install
// --ignore-scripts, with the host node and its npm) resolves, so no package
// cc main installs on this platform has an install script.
t('cc main installs with npm install --ignore-scripts and no install-script package', { timeout: 600_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-deps-'));
  try {
    const app = path.join(dir, 'app');
    await checkout({
      git: 'git', source: DEFAULT_SOURCE, dir: app, branch: 'main',
      nodeVersion: JSON.parse(fs.readFileSync(path.join(repoDir, 'src', 'pins.json'), 'utf8')).node.version,
      log: () => {}, env: process.env,
    });
    const npmCli = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    await installDeps({ node: process.execPath, npmCli, dir: app, env: process.env, log: console.log });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Invariant: cc main still takes its port from an inherited PORT, passes it to
// the server, and defaults to the DEFAULT_PORT this installer assumes (PORT is
// not an installer-contract clause, so this stands in for one).
t('cc main honours an inherited PORT and defaults to the installer\'s DEFAULT_PORT', { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-port-'));
  try {
    await checkout({
      git: 'git', source: DEFAULT_SOURCE, dir: path.join(dir, 'app'), branch: 'main',
      nodeVersion: JSON.parse(fs.readFileSync(path.join(repoDir, 'src', 'pins.json'), 'utf8')).node.version,
      log: () => {}, env: process.env,
    });
    const nsh = fs.readFileSync(path.join(repoDir, 'src', 'port.nsh'), 'utf8');
    const def = Number(/!define DEFAULT_PORT (\d+)/.exec(nsh)[1]);
    const l = await import(pathToFileURL(path.join(dir, 'app', 'bin', 'windows-launch.mjs')).href);
    assert.equal(l.portOf({}), def);
    assert.equal(l.portOf({ PORT: '9123' }), 9123);
    const env = l.launcherEnv({ env: { PORT: '9123', USERPROFILE: 'C:\\Users\\Jo', PATH: '' }, installDir: 'C:\\x', git: null, claude: null });
    assert.equal(env.PORT, '9123');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
