import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectGit, detectClaude, addToUserPath, findOnPath, userEnvScript, readUserEnv, writeUserEnv } from '../src/toolchain.mjs';

const w = path.win32;
const existsIn = (...files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};
const USER = 'C:\\Users\\Jo Bloggs';
const LOCAL = `${USER}\\AppData\\Local`;

test('detectGit: PATH hit with bash.exe', () => {
  const g = 'C:\\Git\\cmd\\git.exe';
  const r = detectGit({ PATH: 'C:\\x;C:\\Git\\cmd' }, existsIn(g, 'C:\\Git\\bin\\bash.exe'));
  assert.deepEqual(r, { gitExe: g, cmdDir: 'C:\\Git\\cmd' });
});

test('detectGit: falls back to the per-user install, then Program Files', () => {
  const local = `${LOCAL}\\Programs\\Git`;
  const r = detectGit({ PATH: '', LOCALAPPDATA: LOCAL, ProgramFiles: 'C:\\Program Files' },
    existsIn(`${local}\\cmd\\git.exe`, `${local}\\bin\\bash.exe`));
  assert.equal(r.gitExe, `${local}\\cmd\\git.exe`);
  const pf = detectGit({ PATH: '', ProgramFiles: 'C:\\Program Files' },
    existsIn('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'));
  assert.equal(pf.cmdDir, 'C:\\Program Files\\Git\\cmd');
});

test('detectGit: git without bash.exe is treated as absent', () => {
  assert.equal(detectGit({ PATH: 'C:\\Git\\cmd' }, existsIn('C:\\Git\\cmd\\git.exe')), null);
});

test('detectGit: a bashless PATH git does not mask a complete per-user one', () => {
  const local = 'C:\\L\\Programs\\Git';
  const r = detectGit({ Path: 'C:\\Bare', LOCALAPPDATA: 'C:\\L' },
    existsIn('C:\\Bare\\git.exe', `${local}\\cmd\\git.exe`, `${local}\\bin\\bash.exe`));
  assert.equal(r.gitExe, `${local}\\cmd\\git.exe`);
});

// The layouts cc's contract test (C8) proves resolveGitBash + gitRootOfBash
// map back to the same root; detectGit accepts each of them.
test('detectGit: accepts every layout the launcher resolves (cmd or bin, quoted PATH, per-user, Program Files)', () => {
  const layouts = [
    { root: 'C:\\Git', env: { PATH: 'C:\\Git\\cmd' }, git: 'C:\\Git\\cmd\\git.exe' },
    { root: 'C:\\Git', env: { PATH: 'C:\\Git\\bin' }, git: 'C:\\Git\\bin\\git.exe' },
    { root: 'C:\\Git', env: { PATH: '"C:\\Git\\cmd"' }, git: 'C:\\Git\\cmd\\git.exe' },
    { root: `${LOCAL}\\Programs\\Git`, env: { PATH: '', LOCALAPPDATA: LOCAL }, git: `${LOCAL}\\Programs\\Git\\cmd\\git.exe` },
    { root: 'C:\\Program Files\\Git', env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, git: 'C:\\Program Files\\Git\\cmd\\git.exe' },
  ];
  for (const { root, env, git } of layouts) {
    assert.deepEqual(detectGit(env, existsIn(git, w.join(root, 'bin', 'bash.exe'))), { gitExe: git, cmdDir: w.dirname(git) }, git);
  }
});

test('detectGit: a git.exe outside cmd or bin (mingw64\\bin) is not accepted; the per-user install is used instead', () => {
  const files = ['C:\\Git\\mingw64\\bin\\git.exe', 'C:\\Git\\bin\\bash.exe'];
  assert.equal(detectGit({ PATH: 'C:\\Git\\mingw64\\bin' }, existsIn(...files)), null);
  const local = `${LOCAL}\\Programs\\Git`;
  const r = detectGit({ PATH: 'C:\\Git\\mingw64\\bin', LOCALAPPDATA: LOCAL },
    existsIn(...files, `${local}\\cmd\\git.exe`, `${local}\\bin\\bash.exe`));
  assert.equal(r.gitExe, `${local}\\cmd\\git.exe`);
});

test('detectGit: usr\\bin and mingw64\\bin on PATH are rejected even with a bash.exe beside them; the Program Files install is used', () => {
  const pf = 'C:\\Program Files\\Git';
  const files = [`${pf}\\usr\\bin\\git.exe`, `${pf}\\usr\\bin\\bash.exe`, `${pf}\\mingw64\\bin\\git.exe`, `${pf}\\mingw64\\bin\\bash.exe`];
  for (const dir of ['usr\\bin', 'mingw64\\bin']) {
    assert.equal(detectGit({ PATH: `${pf}\\${dir}` }, existsIn(...files)), null, dir);
    const r = detectGit({ PATH: `${pf}\\${dir}`, ProgramFiles: 'C:\\Program Files' },
      existsIn(...files, `${pf}\\cmd\\git.exe`, `${pf}\\bin\\bash.exe`));
    assert.deepEqual(r, { gitExe: `${pf}\\cmd\\git.exe`, cmdDir: `${pf}\\cmd` }, dir);
  }
});

test('detectGit: a rejected PATH entry does not mask a later good one', () => {
  const r = detectGit({ PATH: 'C:\\Git\\usr\\bin;C:\\Git\\cmd' },
    existsIn('C:\\Git\\usr\\bin\\git.exe', 'C:\\Git\\usr\\bin\\bash.exe', 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe'));
  assert.deepEqual(r, { gitExe: 'C:\\Git\\cmd\\git.exe', cmdDir: 'C:\\Git\\cmd' });
});

test('detectGit: a bin\\git.exe hit uses the install\'s cmd\\git.exe when it exists', () => {
  const r = detectGit({ PATH: 'C:\\Git\\bin' }, existsIn('C:\\Git\\bin\\git.exe', 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\bin\\bash.exe'));
  assert.deepEqual(r, { gitExe: 'C:\\Git\\cmd\\git.exe', cmdDir: 'C:\\Git\\cmd' });
});

test('detectClaude: .cmd shim rejected, .local\\bin fallback used', () => {
  const exe = `${USER}\\.local\\bin\\claude.exe`;
  assert.equal(detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd')), null);
  const r = detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd', exe));
  assert.deepEqual(r, { claudeExe: exe, dir: `${USER}\\.local\\bin` });
});

test('findOnPath: case-insensitive PATH key', () => {
  assert.equal(findOnPath('git', { pAtH: 'C:\\a;C:\\b' }, existsIn('C:\\b\\git.exe')), 'C:\\b\\git.exe');
});

// Models the userEnvScript channel over a fake HKCU\Environment keyed by
// `name`: `read` takes base64(UTF-8 JSON {name}) and prints
// base64(UTF-8 JSON {exists, kind, value}); `write` decodes
// base64(UTF-8 JSON {name, value, kind}) from stdin, refuses a kind other than
// String/ExpandString or a non-string value, and stores it. Failures are exit
// 1 with a (localized) message on stderr. `value` is null when absent. The
// helper's own `Path` is the one under test; `store` is its entry.
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
function fakePs(value, { kind = 'ExpandString', readFail, writeFail } = {}) {
  const calls = [];
  const stores = value === null ? {} : { Path: { kind, value } };
  return {
    calls,
    get store() { return stores.Path ?? null; },
    stores,
    runPs: async (script, input) => {
      assert.match(input, /^[A-Za-z0-9+/]+={0,2}$/, 'only base64 crosses the pipe');
      const req = JSON.parse(Buffer.from(input, 'base64').toString('utf8'));
      if (script === userEnvScript('read')) {
        calls.push({ op: 'read', req });
        if (readFail !== undefined) return { code: 1, stdout: '', stderr: readFail };
        const st = stores[req.name];
        return { code: 0, stdout: b64(st ? { exists: true, ...st } : { exists: false }) + '\r\n', stderr: '' };
      }
      if (script === userEnvScript('write')) {
        calls.push({ op: 'write', req });
        if (writeFail !== undefined) return { code: 1, stdout: '', stderr: writeFail };
        if (!['String', 'ExpandString'].includes(req.kind) || typeof req.value !== 'string') return { code: 1, stdout: '', stderr: 'refusing' };
        stores[req.name] = { kind: req.kind, value: req.value };
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error('unexpected script');
    },
  };
}
const writes = (f) => f.calls.filter((c) => c.op === 'write');

// Invariant: addToUserPath addresses the value `Path` on both the read and the write.
test('addToUserPath: reads and writes the value named Path', async () => {
  const f = fakePs('C:\\a');
  await addToUserPath('C:\\n', { runPs: f.runPs, env: {} });
  assert.deepEqual(f.calls.map((c) => [c.op, c.req.name]), [['read', 'Path'], ['write', 'Path']]);
});

test('addToUserPath: appends once, keeps %VAR% and the ExpandString kind', async () => {
  const f = fakePs('%USERPROFILE%\\bin;C:\\Tools');
  const dir = `${USER}\\.local\\bin`;
  assert.equal(await addToUserPath(dir, { runPs: f.runPs, env: { USERPROFILE: USER } }), true);
  assert.deepEqual(f.store, { kind: 'ExpandString', value: `%USERPROFILE%\\bin;C:\\Tools;${dir}` });
  assert.equal(await addToUserPath(dir, { runPs: f.runPs, env: { USERPROFILE: USER } }), false);
  assert.equal(writes(f).length, 1);
});

test('addToUserPath: a String (REG_SZ) Path keeps its kind', async () => {
  const f = fakePs('C:\\a', { kind: 'String' });
  await addToUserPath('C:\\n', { runPs: f.runPs, env: {} });
  assert.deepEqual(f.store, { kind: 'String', value: 'C:\\a;C:\\n' });
});

test('addToUserPath: recognises an existing %VAR% or differently-cased entry', async () => {
  const dir = `${USER}\\.local\\bin`;
  for (const existing of ['%USERPROFILE%\\.local\\bin', dir.toUpperCase() + '\\']) {
    const f = fakePs(`C:\\a;${existing}`);
    assert.equal(await addToUserPath(dir, { runPs: f.runPs, env: { USERPROFILE: USER } }), false);
    assert.equal(writes(f).length, 0);
  }
});

test('addToUserPath: an absent Path is created as exactly dir, kind ExpandString', async () => {
  const f = fakePs(null);
  assert.equal(await addToUserPath('C:\\n', { runPs: f.runPs, env: {} }), true);
  assert.deepEqual(f.store, { kind: 'ExpandString', value: 'C:\\n' });
});

test('addToUserPath: a long Path is not truncated', async () => {
  const long = Array.from({ length: 3000 }, (_, i) => `C:\\dir${i}`).join(';');
  const f = fakePs(long);
  await addToUserPath('C:\\n', { runPs: f.runPs, env: {} });
  assert.equal(f.store.value, `${long};C:\\n`);
});

test('addToUserPath: non-ASCII entries round-trip unchanged', async () => {
  const existing = 'C:\\Users\\Müller\\bin;D:\\工具;%USERPROFILE%\\Ångström';
  const dir = 'C:\\Users\\Müller\\.local\\bin';
  const f = fakePs(existing);
  assert.equal(await addToUserPath(dir, { runPs: f.runPs, env: {} }), true);
  assert.equal(f.store.value, `${existing};${dir}`);
  assert.equal(f.store.value.includes('\uFFFD'), false);
  assert.equal(await addToUserPath(dir, { runPs: f.runPs, env: {} }), false);
});

test('addToUserPath: a failed read (exit 1, any stderr) throws and never writes', async () => {
  for (const stderr of ['FEHLER: Zugriff verweigert\r\n', 'Requested registry access is not allowed.\r\n', '']) {
    const f = fakePs('C:\\a', { readFail: stderr });
    await assert.rejects(addToUserPath('C:\\n', { runPs: f.runPs, env: {} }), /reading the user Path failed \(exit 1\)/);
    assert.equal(writes(f).length, 0, stderr);
  }
});

test('addToUserPath: a read that exits 0 with unparseable output throws without writing', async () => {
  const outs = ['', 'garbage output', b64({ value: 'C:\\x' }), Buffer.from('not json').toString('base64'), `#< CLIXML\r\n${b64({ exists: false })}`];
  for (const stdout of outs) {
    const calls = [];
    const runPs = async (script, input) => { calls.push(script); return { code: 0, stdout, stderr: '' }; };
    await assert.rejects(addToUserPath('C:\\n', { runPs, env: {} }), /could not be parsed/, stdout);
    assert.equal(calls.length, 1, stdout);
  }
});

test('addToUserPath: a Path of another kind (Binary, MultiString) throws without writing', async () => {
  for (const [kind, value] of [['Binary', [67, 0, 58, 0]], ['MultiString', ['C:\\a', 'C:\\b']]]) {
    const f = fakePs(value, { kind });
    await assert.rejects(addToUserPath('C:\\n', { runPs: f.runPs, env: {} }), new RegExp(`unexpected kind ${kind}`));
    assert.equal(writes(f).length, 0, kind);
  }
});

test('addToUserPath: a failed write throws', async () => {
  const f = fakePs('C:\\a', { writeFail: 'Path read back differs from what was written' });
  await assert.rejects(addToUserPath('C:\\n', { runPs: f.runPs, env: {} }), /writing the user Path failed \(exit 1\): Path read back differs/);
});

// Invariant: values are read unexpanded and never through reg.exe, and both
// ops take the value name from the request, never from the script text.
test('userEnvScript: reads unexpanded, never through reg.exe, name comes from the request', () => {
  for (const op of ['read', 'write']) {
    const s = userEnvScript(op);
    assert.match(s, /'DoNotExpandEnvironmentNames'/);
    assert.doesNotMatch(s, /reg(\.exe)?\s+(query|add)/i);
    assert.match(s, /\$req\.name/);
    assert.doesNotMatch(s, /'Path'/);
  }
});

// Invariant: readUserEnv / writeUserEnv carry any value name through the
// channel, so PROJECTS_ROOT and Path do not interfere.
test('readUserEnv / writeUserEnv: addressed by name', async () => {
  const f = fakePs('C:\\a');
  await writeUserEnv('PROJECTS_ROOT', 'D:\\p', 'String', { runPs: f.runPs });
  assert.deepEqual(await readUserEnv('PROJECTS_ROOT', { runPs: f.runPs }), { exists: true, kind: 'String', value: 'D:\\p' });
  assert.deepEqual(await readUserEnv('Absent', { runPs: f.runPs }), { exists: false });
  assert.equal(f.store.value, 'C:\\a');
  await assert.rejects(readUserEnv('X', { runPs: fakePs('v', { readFail: 'denied' }).runPs }), /reading the user X failed \(exit 1\): denied/);
  await assert.rejects(writeUserEnv('X', 'v', 'Binary', { runPs: f.runPs }), /writing the user X failed/);
});
