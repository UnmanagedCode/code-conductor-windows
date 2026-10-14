import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractProblems, contractError, installScriptProblems, satisfiesEngines, CONTRACT_URL, LAUNCHER_REL } from '../src/contract.mjs';

const good = () => ({
  [LAUNCHER_REL]: '// launcher',
  'package.json': JSON.stringify({ version: '1.2.3', engines: { node: '>=24' } }),
  LICENSE: 'text',
});
const check = (files, node = '24.21.0') => contractProblems(async (rel) => files[rel] ?? null, node);

// Invariant: a revision with every required file, a string version, no root
// install lifecycle scripts and a satisfiable engines.node has no problems,
// and its version is returned; it needs no package-lock.json.
test('contractProblems: a passing revision returns no problems and its version', async () => {
  assert.deepEqual(await check(good()), { problems: [], version: '1.2.3' });
});

// Invariant: each required file's absence is its own named problem.
test('contractProblems: each missing file is reported by name', async () => {
  for (const f of [LAUNCHER_REL, 'package.json', 'LICENSE']) {
    const files = good();
    delete files[f];
    const { problems } = await check(files);
    assert.ok(problems.includes(`${f} is missing`), `${f}: ${problems}`);
  }
});

// Invariant: unparseable JSON and a non-string version are problems, not throws.
test('contractProblems: unparseable package.json and a non-string version are problems', async () => {
  assert.match((await check({ ...good(), 'package.json': '{nope' })).problems.join('\n'), /package\.json does not parse/);
  assert.ok((await check({ ...good(), 'package.json': '{"version":3,"engines":{"node":">=24"}}' })).problems.includes('package.json has no string "version"'));
});

// Invariant: a ref that still tracks a lock is not judged by it, even an
// unparseable one or one listing an install-script package (that is checked
// on the installed tree instead, by installScriptProblems).
test('contractProblems: a tracked package-lock.json is not read', async () => {
  const scripted = JSON.stringify({ packages: { '': {}, 'node_modules/fsevents': { hasInstallScript: true, os: ['darwin'] } } });
  assert.deepEqual((await check({ ...good(), 'package-lock.json': scripted })).problems, []);
  assert.deepEqual((await check({ ...good(), 'package-lock.json': '{nope' })).problems, []);
});

// Invariant: every root install lifecycle script (which --ignore-scripts
// would skip silently) is refused by name; other scripts are fine.
test('contractProblems: root install lifecycle scripts are refused by name', async () => {
  const withScripts = (scripts) => ({ ...good(), 'package.json': JSON.stringify({ version: '1', engines: { node: '>=24' }, scripts }) });
  for (const k of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    assert.deepEqual((await check(withScripts({ [k]: 'x' }))).problems, [`package.json has install lifecycle scripts, which the installer does not run: ${k}`], k);
  }
  assert.deepEqual((await check(withScripts({ postinstall: 'x', prepare: 'y', start: 'z' }))).problems,
    ['package.json has install lifecycle scripts, which the installer does not run: postinstall, prepare']);
  assert.deepEqual((await check(withScripts({ start: 'node server.js', test: 'node --test' }))).problems, []);
});

// Invariant: every installed package with hasInstallScript is named (the
// user's machine has no build toolchain and npm ran no scripts); a missing or
// unparseable hidden lockfile is a problem, never a pass.
test('installScriptProblems: scripted packages named; missing or unparseable is a problem; clean passes', () => {
  const lock = JSON.stringify({ packages: { 'node_modules/ok': {}, 'node_modules/native': { hasInstallScript: true }, 'node_modules/b': { hasInstallScript: true } } });
  assert.deepEqual(installScriptProblems(lock), ['packages with install scripts: node_modules/native, node_modules/b']);
  assert.deepEqual(installScriptProblems(null), ['node_modules/.package-lock.json is missing']);
  assert.match(installScriptProblems('{nope')[0], /^node_modules\/\.package-lock\.json does not parse: /);
  assert.deepEqual(installScriptProblems(JSON.stringify({ packages: { 'node_modules/ok': { version: '1.0.0' } } })), []);
});

// Invariant: engines.node the running Node does not satisfy, or in an
// unreadable form, is refused with a distinct message.
test('contractProblems: engines.node unsatisfied or unreadable', async () => {
  const withEngines = (node) => ({ ...good(), 'package.json': JSON.stringify({ version: '1', engines: { node } }) });
  assert.match((await check(withEngines('>=99'))).problems[0], /bundled Node 24\.21\.0 does not satisfy engines\.node ">=99"/);
  assert.match((await check(withEngines('^24'))).problems[0], /not of the form >=N\[\.N\[\.N\]\]/);
  assert.match((await check({ ...good(), 'package.json': '{"version":"1"}' })).problems[0], /engines\.node undefined is not of the form/);
});

// Invariant: contractError lists every problem and cites the contract URL.
test('contractError: lists each problem and cites CONTRACT_URL', () => {
  const msg = contractError(['a', 'b']);
  assert.ok(msg.includes('- a') && msg.includes('- b') && msg.includes(CONTRACT_URL), msg);
});

// Invariant: >=N[.N[.N]] is compared numerically; other forms are unreadable (null).
test('satisfiesEngines: >=N[.N[.N]] compared numerically; other forms unreadable', () => {
  assert.equal(satisfiesEngines('24.21.0', '>=24'), true);
  assert.equal(satisfiesEngines('24.21.0', '>= 24.21'), true);
  assert.equal(satisfiesEngines('24.21.0', '>=24.21.1'), false);
  assert.equal(satisfiesEngines('24.9.0', '>=24.10'), false);
  assert.equal(satisfiesEngines('25.0.0', '>=24.99.99'), true);
  assert.equal(satisfiesEngines('24.21.0', '^24'), null);
});
