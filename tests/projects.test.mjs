import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProjectsRoot, persistProjectsRoot, defaultProjectsRoot } from '../src/projects.mjs';
import { userEnvScript } from '../src/toolchain.mjs';

const INSTALL = 'C:\\Users\\Jo\\AppData\\Local\\Programs\\code-conductor';
const ENV = { USERPROFILE: 'C:\\Users\\Jo' };
const noStat = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };

// Invariant: the default mirrors cc's launcher: %USERPROFILE%\code-conductor.
test('defaultProjectsRoot is %USERPROFILE%\\code-conductor', () => {
  assert.equal(defaultProjectsRoot(ENV), 'C:\\Users\\Jo\\code-conductor');
});

// Invariant: only an absolute drive or UNC path is accepted.
test('checkProjectsRoot: relative and drive-relative paths are refused; drive and UNC accepted', () => {
  for (const bad of ['projects', '.\\x', 'D:x', '\\rooted', '']) {
    assert.throws(() => checkProjectsRoot(bad, INSTALL, { stat: noStat }), /must be an absolute path/, bad);
  }
  assert.equal(checkProjectsRoot('D:\\My projects', INSTALL, { stat: noStat }), 'D:\\My projects');
  assert.equal(checkProjectsRoot('\\\\srv\\share\\proj', INSTALL, { stat: noStat }), '\\\\srv\\share\\proj');
});

// Invariant: a trailing separator is stripped, except at a drive root.
test('checkProjectsRoot: trailing backslash stripped, a drive root kept', () => {
  assert.equal(checkProjectsRoot('D:\\My projects\\', INSTALL, { stat: noStat }), 'D:\\My projects');
  assert.equal(checkProjectsRoot('D:\\', INSTALL, { stat: noStat }), 'D:\\');
});

// Invariant: the install dir is deleted on uninstall, so the root may be
// neither it nor inside it, whatever the casing; a sibling with the same prefix is fine.
test('checkProjectsRoot: inside or equal to the install dir is refused, case-insensitively', () => {
  for (const bad of [INSTALL, INSTALL.toUpperCase(), `${INSTALL}\\`, `${INSTALL}\\app`, `${INSTALL.toLowerCase()}\\x\\y`]) {
    assert.throws(() => checkProjectsRoot(bad, INSTALL, { stat: noStat }), /must not be inside the install directory/, bad);
  }
  assert.equal(checkProjectsRoot(`${INSTALL}-projects`, INSTALL, { stat: noStat }), `${INSTALL}-projects`);
});

// Invariant: an existing file is refused; an existing directory is fine; a
// stat error other than "absent" is not swallowed.
test('checkProjectsRoot: an existing file is refused, a directory accepted, other stat errors rethrown', () => {
  assert.throws(() => checkProjectsRoot('D:\\f', INSTALL, { stat: () => ({ isDirectory: () => false }) }), /exists but is not a directory/);
  assert.equal(checkProjectsRoot('D:\\d', INSTALL, { stat: () => ({ isDirectory: () => true }) }), 'D:\\d');
  assert.throws(() => checkProjectsRoot('D:\\d', INSTALL, { stat: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
});

// Models the user-env channel over a fake HKCU\Environment keyed by `name`.
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
function fakePs(initial = {}) {
  const store = { ...initial };
  const writes = [];
  return {
    store, writes,
    runPs: async (script, input) => {
      const req = JSON.parse(Buffer.from(input, 'base64').toString('utf8'));
      if (script === userEnvScript('read')) {
        const v = store[req.name];
        return { code: 0, stdout: b64(v ? { exists: true, ...v } : { exists: false }), stderr: '' };
      }
      if (script === userEnvScript('write')) {
        if (!['String', 'ExpandString'].includes(req.kind)) return { code: 1, stdout: '', stderr: 'refusing' };
        writes.push(req);
        store[req.name] = { kind: req.kind, value: req.value };
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error('unexpected script');
    },
  };
}
const persist = (root, f, env = ENV, extra = {}) => {
  const lines = [];
  const made = [];
  return persistProjectsRoot(root, { runPs: f.runPs, env, log: (m) => lines.push(m), mkdir: (d) => made.push(d), ...extra })
    .then((changed) => ({ changed, lines, made }));
};

// Invariant: the folder is created, and an unset variable with the default
// root is left unset (the registry is not touched for default users).
test('persistProjectsRoot: absent + default root creates the folder and writes nothing', async () => {
  const f = fakePs();
  const r = await persist('C:\\Users\\Jo\\code-conductor', f);
  assert.equal(r.changed, false);
  assert.deepEqual(r.made, ['C:\\Users\\Jo\\code-conductor']);
  assert.equal(f.writes.length, 0);
  assert.match(r.lines[0], /unchanged/);
});

// Invariant: a custom root with no existing value is written as a String.
test('persistProjectsRoot: absent + custom root writes a String', async () => {
  const f = fakePs();
  const r = await persist('D:\\My projects', f);
  assert.equal(r.changed, true);
  assert.deepEqual(f.store.PROJECTS_ROOT, { kind: 'String', value: 'D:\\My projects' });
  assert.equal(f.writes[0].name, 'PROJECTS_ROOT');
});

// Invariant: a root equal to the inherited PROJECTS_ROOT (any case, trailing
// backslash) is not rewritten.
test('persistProjectsRoot: an inherited PROJECTS_ROOT that equals the root causes no write', async () => {
  const f = fakePs();
  const r = await persist('D:\\Mine', f, { ...ENV, projects_root: 'd:\\mine\\' });
  assert.equal(r.changed, false);
  assert.equal(f.writes.length, 0);
});

// Invariant: an existing %VAR% value that expands to the chosen root keeps
// its form; a different root replaces it but keeps the ExpandString kind.
test('persistProjectsRoot: ExpandString value equal when expanded is kept; a different root keeps the kind', async () => {
  const f = fakePs({ PROJECTS_ROOT: { kind: 'ExpandString', value: '%USERPROFILE%\\work' } });
  assert.equal((await persist('C:\\Users\\Jo\\work', f)).changed, false);
  assert.equal(f.writes.length, 0);
  assert.equal((await persist('E:\\other', f)).changed, true);
  assert.deepEqual(f.store.PROJECTS_ROOT, { kind: 'ExpandString', value: 'E:\\other' });
});

// Invariant: the stored user value outranks an inherited one when deciding
// "unchanged", since that is what a fresh launch resolves.
test('persistProjectsRoot: the user value, not the inherited env, decides unchanged', async () => {
  const f = fakePs({ PROJECTS_ROOT: { kind: 'String', value: 'D:\\a' } });
  assert.equal((await persist('D:\\b', f, { ...ENV, PROJECTS_ROOT: 'D:\\b' })).changed, true);
  assert.equal(f.store.PROJECTS_ROOT.value, 'D:\\b');
});

// Invariant: a value of another kind fails closed and is never overwritten.
test('persistProjectsRoot: a Binary PROJECTS_ROOT throws without writing', async () => {
  const f = fakePs({ PROJECTS_ROOT: { kind: 'Binary', value: [1] } });
  await assert.rejects(persist('D:\\x', f), /unexpected kind Binary/);
  assert.equal(f.writes.length, 0);
});

// Invariant: non-ASCII roots cross the channel unchanged.
test('persistProjectsRoot: a non-ASCII root round-trips', async () => {
  const f = fakePs();
  await persist('D:\\Projekte\\Müller\\工具', f);
  assert.equal(f.store.PROJECTS_ROOT.value, 'D:\\Projekte\\Müller\\工具');
});
