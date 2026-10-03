// Real fetch: the current cc main on GitHub meets the installer contract with
// the pinned Node, as install time will check it (the build no longer does).
//   RUN_REAL_CC_FETCH=1 node --test tests/checkout.real.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkout } from '../src/setup.mjs';
import { DEFAULT_SOURCE } from '../src/build.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = process.env.RUN_REAL_CC_FETCH ? test : test.skip.bind(test);

// Invariant: a fresh checkout() of the real DEFAULT_SOURCE main succeeds, so
// cc main passes the contract (launcher, lockfile without install scripts,
// engines.node) against the Node this installer pins.
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
