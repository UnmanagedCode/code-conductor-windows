import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureGit, downloadWithRetry, installDeps, main } from '../src/setup.mjs';
import { CONTRACT_URL } from '../src/contract.mjs';

const buf = Buffer.from('installer bytes');
const pin = { version: '1', url: 'https://example.invalid/Git-1-64-bit.exe', sha256: crypto.createHash('sha256').update(buf).digest('hex') };
const res = (b) => ({ ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });

test('ensureGit: a sha256 mismatch rejects before the installer runs', async () => {
  await assert.rejects(
    ensureGit({ env: {}, pin, log: () => {}, fetchBuffer: async () => Buffer.from('tampered'), run: () => assert.fail('must not run') }),
    /sha256 mismatch/);
});

test('downloadWithRetry: throws twice then succeeds returns the buffer', async () => {
  let n = 0;
  const out = await downloadWithRetry(pin.url, {
    sleep: async () => {},
    fetchFn: async () => { if (++n < 3) throw new Error('fetch failed'); return res(buf); },
  });
  assert.equal(n, 3);
  assert.deepEqual(out, buf);
});

test('downloadWithRetry: exhausted retries reject with the cause', async () => {
  let n = 0;
  await assert.rejects(downloadWithRetry(pin.url, {
    sleep: async () => {},
    fetchFn: async () => { n++; throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); },
  }), /attempt 3\/3.*UND_ERR_CONNECT_TIMEOUT/);
  assert.equal(n, 3);
});

test('downloadWithRetry: an HTTP error status is retried and reported', async () => {
  await assert.rejects(downloadWithRetry(pin.url, { sleep: async () => {}, fetchFn: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

// installDeps in a fresh dir, with a fake npm that records its call, exits
// `code` and leaves `hidden` (null: nothing) as node_modules/.package-lock.json.
async function withInstall({ code = 0, hidden }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-deps-'));
  const calls = [];
  const lines = [];
  const run = async (log, file, args, opts) => {
    calls.push({ file, args, opts });
    if (hidden !== null) {
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), hidden);
    }
    return code;
  };
  const env = { PATH: 'C:\\node' };
  try {
    await fn(() => installDeps({ node: 'C:\\inst\\node\\node.exe', npmCli: 'npm-cli.js', dir, env, log: (m) => lines.push(m), run }), { dir, env, calls, lines });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const clean = JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' } } });

// Invariant: dependencies are installed by running the given node on
// npm-cli.js with `install --ignore-scripts` in the checkout, with the given
// env, logged; a clean installed tree resolves.
test('installDeps: runs npm install --ignore-scripts in dir with env, logged; a clean tree resolves', async () => {
  await withInstall({ hidden: clean }, async (go, { dir, env, calls, lines }) => {
    await go();
    assert.deepEqual(calls, [{ file: 'C:\\inst\\node\\node.exe', args: ['npm-cli.js', 'install', '--ignore-scripts'], opts: { cwd: dir, env } }]);
    assert.ok(lines.includes('npm: npm install --ignore-scripts'), lines.join('\n'));
  });
});

// Invariant: a failing npm fails setup, naming its exit code.
test('installDeps: a nonzero npm exit rejects naming the exit code', async () => {
  await withInstall({ code: 7, hidden: clean }, async (go) => {
    await assert.rejects(go(), /failed \(exit 7\)/);
  });
});

// Invariant: an installed package with an install script (skipped, since no
// toolchain) fails setup, naming the package and citing the contract URL.
test('installDeps: an installed package with an install script rejects naming it and CONTRACT_URL', async () => {
  const hidden = JSON.stringify({ packages: { 'node_modules/a': {}, 'node_modules/native': { hasInstallScript: true } } });
  await withInstall({ hidden }, async (go) => {
    const err = await go().then(() => assert.fail('resolved'), (e) => e);
    assert.match(err.message, /install scripts: node_modules\/native/);
    assert.ok(err.message.includes(CONTRACT_URL), err.message);
  });
});

// Invariant: without npm's record of the installed tree setup cannot check
// for install scripts, so it fails rather than passes.
test('installDeps: a missing hidden lockfile rejects', async () => {
  await withInstall({ hidden: null }, async (go) => {
    await assert.rejects(go(), /node_modules\/\.package-lock\.json is missing/);
  });
});

const setupArgs = (dir, extra) => ['--install-dir', dir, '--source', 'x', '--branch', 'main', '--projects-root', 'D:\\p', ...extra];

// Invariant: the port is a required argument.
test('main without --port rejects as missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-port-'));
  try { await assert.rejects(main(setupArgs(dir, []), {}), /missing --port/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Invariant: a bad port fails before any Git/claude download, like a bad projects folder.
test('main with --port 0 rejects before any download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-port-'));
  try { await assert.rejects(main(setupArgs(dir, ['--port', '0']), {}), /whole number from 1 to 65535/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const setupCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'setup.mjs');
const runCheck = (cwd, ...flags) => spawnSync(process.execPath, [setupCli, '--check', '--install-dir', 'C:\\inst', ...flags], { cwd, encoding: 'utf8' });

// Invariant: --check reads exactly the accepted set of checkPort/checkProjectsRoot,
// reports a refusal as exit 1 plus one stderr line (the contract the installer reads),
// checks only the flags given, and writes nothing.
test('--check: refusals exit 1 with one line, acceptances exit 0 silently, nothing is written', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-setup-check-'));
  try {
    const refused = (flags, re) => {
      const r = runCheck(cwd, ...flags);
      assert.equal(r.status, 1, flags.join(' '));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, re);
      assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    };
    for (const p of ['abc', '0', '70000', '09123', '']) refused(['--port', p], /whole number from 1 to 65535/);
    refused(['--projects-root', 'relative'], /must be an absolute path/);
    refused(['--projects-root', 'C:\\inst\\p'], /must not be inside the install directory/);
    refused(['--projects-root', 'D:\\p', '--port', '0'], /whole number from 1 to 65535/);
    const ok = (...flags) => {
      const r = runCheck(cwd, ...flags);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], flags.join(' '));
    };
    ok('--projects-root', 'D:\\p', '--port', '9000');
    ok('--projects-root', 'D:\\p');
    ok('--port', '9000');
    const none = spawnSync(process.execPath, [setupCli, '--check', '--install-dir', 'C:\\inst'], { cwd, encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /missing/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
