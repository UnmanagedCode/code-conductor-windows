import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureGit, downloadWithRetry, main } from '../src/setup.mjs';

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
