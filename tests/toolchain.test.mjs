import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { detectGit, detectClaude, addToUserPath, findOnPath } from '../src/toolchain.mjs';

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

test('detectClaude: .cmd shim rejected, .local\\bin fallback used', () => {
  const exe = `${USER}\\.local\\bin\\claude.exe`;
  assert.equal(detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd')), null);
  const r = detectClaude({ PATH: 'C:\\npm', USERPROFILE: USER }, existsIn('C:\\npm\\claude.cmd', exe));
  assert.deepEqual(r, { claudeExe: exe, dir: `${USER}\\.local\\bin` });
});

test('findOnPath: case-insensitive PATH key', () => {
  assert.equal(findOnPath('git', { pAtH: 'C:\\a;C:\\b' }, existsIn('C:\\b\\git.exe')), 'C:\\b\\git.exe');
});

// Models real reg.exe: `query HKCU\Environment` prints the key header and one
// line per value; any failure is exit 1 with a localized message on stderr.
function fakeReg(initial, { type = 'REG_EXPAND_SZ' } = {}) {
  const calls = [];
  let value = initial;
  return {
    calls,
    get value() { return value; },
    reg: async (args) => {
      calls.push(args);
      if (args[0] === 'query') {
        const lines = [
          '', 'HKEY_CURRENT_USER\\Environment',
          `    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp`,
          `    PATHEXT    REG_SZ    .COM;.EXE;.BAT;.CMD`,
          ...(value === null ? [] : [`    Path    ${type}    ${value}`]),
          '', '',
        ];
        return { code: 0, stdout: lines.join('\r\n'), stderr: '' };
      }
      value = args[args.indexOf('/d') + 1];
      return { code: 0, stdout: 'The operation completed successfully.\r\n', stderr: '' };
    },
  };
}

test('addToUserPath: appends once, keeps %VAR%, REG_EXPAND_SZ', async () => {
  const f = fakeReg('%USERPROFILE%\\bin;C:\\Tools');
  const dir = `${USER}\\.local\\bin`;
  assert.equal(await addToUserPath(dir, { reg: f.reg, env: { USERPROFILE: USER } }), true);
  assert.equal(f.value, `%USERPROFILE%\\bin;C:\\Tools;${dir}`);
  const add = f.calls.find((c) => c[0] === 'add');
  assert.equal(add[add.indexOf('/t') + 1], 'REG_EXPAND_SZ');
  assert.equal(await addToUserPath(dir, { reg: f.reg, env: { USERPROFILE: USER } }), false);
});

test('addToUserPath: recognises an existing %VAR% or differently-cased entry', async () => {
  const dir = `${USER}\\.local\\bin`;
  for (const existing of ['%USERPROFILE%\\.local\\bin', dir.toUpperCase() + '\\']) {
    const f = fakeReg(`C:\\a;${existing}`);
    assert.equal(await addToUserPath(dir, { reg: f.reg, env: { USERPROFILE: USER } }), false);
    assert.equal(f.calls.some((c) => c[0] === 'add'), false);
  }
});

test('addToUserPath: no Path line is created as exactly dir; PATHEXT is not mistaken for it', async () => {
  const f = fakeReg(null);
  assert.equal(await addToUserPath('C:\\n', { reg: f.reg, env: {} }), true);
  assert.equal(f.value, 'C:\\n');
});

test('addToUserPath: a long Path is not truncated', async () => {
  const long = Array.from({ length: 300 }, (_, i) => `C:\\dir${i}`).join(';');
  const g = fakeReg(long);
  await addToUserPath('C:\\n', { reg: g.reg, env: {} });
  assert.equal(g.value, `${long};C:\\n`);
});

test('addToUserPath: a failed query (exit 1, any stderr) throws and never writes', async () => {
  for (const stderr of ['FEHLER: Zugriff verweigert\r\n', 'ERROR: The system was unable to find the specified registry key or value.\r\n', '']) {
    const calls = [];
    const reg = async (a) => { calls.push(a); return a[0] === 'query' ? { code: 1, stdout: '', stderr } : { code: 0, stdout: '', stderr: '' }; };
    await assert.rejects(addToUserPath('C:\\n', { reg, env: {} }), /reg query HKCU\\Environment failed \(exit 1\)/);
    assert.equal(calls.some((c) => c[0] === 'add'), false, stderr);
  }
});

test('addToUserPath: exit 0 without the key header throws without writing', async () => {
  const calls = [];
  const reg = async (a) => { calls.push(a); return { code: 0, stdout: 'garbage\r\n    Path    REG_SZ    C:\\x\r\n', stderr: '' }; };
  await assert.rejects(addToUserPath('C:\\n', { reg, env: {} }), /could not be parsed/);
  assert.equal(calls.some((c) => c[0] === 'add'), false);
});

test('addToUserPath: a Path of type REG_BINARY throws without writing', async () => {
  const f = fakeReg('43003a005c00', { type: 'REG_BINARY' });
  await assert.rejects(addToUserPath('C:\\n', { reg: f.reg, env: {} }), /unexpected type REG_BINARY/);
  assert.equal(f.calls.some((c) => c[0] === 'add'), false);
});

test('addToUserPath: the query argv is exactly query HKCU\\Environment', async () => {
  const f = fakeReg('C:\\a');
  await addToUserPath('C:\\a', { reg: f.reg, env: {} });
  assert.deepEqual(f.calls, [['query', 'HKCU\\Environment']]);
});
