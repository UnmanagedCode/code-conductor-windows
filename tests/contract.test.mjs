import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractProblems, contractError, satisfiesEngines, CONTRACT_URL, LAUNCHER_REL } from '../src/contract.mjs';

const good = () => ({
  [LAUNCHER_REL]: '// launcher',
  'package.json': JSON.stringify({ version: '1.2.3', engines: { node: '>=24' } }),
  'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { version: '1.0.0' } } }),
  LICENSE: 'text',
});
const check = (files, node = '24.21.0') => contractProblems(async (rel) => files[rel] ?? null, node);

// Invariant: a revision with every required file, a string version, no
// install-script packages and a satisfiable engines.node has no problems,
// and its version is returned.
test('contractProblems: a passing revision returns no problems and its version', async () => {
  assert.deepEqual(await check(good()), { problems: [], version: '1.2.3' });
});

// Invariant: each required file's absence is its own named problem.
test('contractProblems: each missing file is reported by name', async () => {
  for (const f of [LAUNCHER_REL, 'package.json', 'package-lock.json', 'LICENSE']) {
    const files = good();
    delete files[f];
    const { problems } = await check(files);
    assert.ok(problems.includes(`${f} is missing`), `${f}: ${problems}`);
  }
});

// Invariant: unparseable JSON and a non-string version are problems, not throws.
test('contractProblems: unparseable package.json / lockfile and a non-string version are problems', async () => {
  assert.match((await check({ ...good(), 'package.json': '{nope' })).problems.join('\n'), /package\.json does not parse/);
  assert.match((await check({ ...good(), 'package-lock.json': '{nope' })).problems.join('\n'), /package-lock\.json does not parse/);
  assert.ok((await check({ ...good(), 'package.json': '{"version":3,"engines":{"node":">=24"}}' })).problems.includes('package.json has no string "version"'));
});

// Invariant: a lockfile package with hasInstallScript is refused and named
// (npm ci on the user's machine has no build toolchain).
test('contractProblems: a package with an install script is named', async () => {
  const lock = JSON.stringify({ packages: { '': {}, 'node_modules/ok': {}, 'node_modules/native': { hasInstallScript: true } } });
  const { problems } = await check({ ...good(), 'package-lock.json': lock });
  assert.deepEqual(problems, ['package-lock.json has packages with install scripts: node_modules/native']);
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
