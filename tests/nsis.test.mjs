// Static checks of the NSIS sources, which cannot run on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_ARGS } from '../src/setup.mjs';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (f) => fs.readFileSync(path.join(srcDir, f), 'utf8');
const installer = read('installer.nsi');
const launcher = read('launcher.nsi');

// Invariant: the installer passes every flag setup requires (adding one on only
// one side fails npm test, not a Windows install).
test('the installer passes exactly the flags setup.mjs requires', () => {
  const line = installer.split('\n').find((l) => l.includes('setup.mjs" --install-dir'));
  assert.ok(line, 'setup call not found');
  const flags = [...line.matchAll(/ --([a-z-]+) /g)].map((m) => m[1]);
  assert.deepEqual([...flags].sort(), [...REQUIRED_ARGS].sort());
});

// Invariant: every module setup.mjs imports (transitively) is copied into
// $PLUGINSDIR, so a new module cannot be left out of the installer.
test('every module setup.mjs imports is shipped and staged', () => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of read(f).matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) walk(m[1]);
  };
  walk('setup.mjs');
  const build = read('build.mjs');
  for (const f of seen) {
    assert.ok(installer.includes(`File "\${STAGE}\\${f}"`), `${f} has no File line in installer.nsi`);
    assert.ok(build.includes(`'${f}'`), `${f} is not in SHIPPED`);
  }
});

// Invariant: the stub, install and uninstall all read the stored port before
// they talk to the launcher.
test('the stub and the uninstaller read the stored port first', () => {
  for (const [name, text] of [['launcher.nsi', launcher], ['installer.nsi', installer]]) {
    assert.match(text, /!include "\$\{__FILEDIR__\}\\port\.nsh"/, name);
  }
  assert.ok(launcher.indexOf('UseStoredPort') > 0 && launcher.indexOf('UseStoredPort') < launcher.indexOf('nsExec'));
  const un = installer.slice(installer.indexOf('Section "Uninstall"'));
  const use = un.search(/!insertmacro (UseStoredPort|ResolvePort)/);
  assert.ok(use > 0 && use < un.indexOf('!insertmacro StopRunning'));
  assert.match(read('port.nsh'), /!macro UseStoredPort[\s\S]*SetEnvironmentVariable\(t "PORT"/);
});

// Invariant: both valued switches share one implementation of the quoting rules.
test('/PROJECTS= and /PORT= go through ParseValueSwitch', () => {
  assert.equal((installer.match(/^Function Parse\w+/gm) ?? []).filter((f) => f !== 'Function ParseNoDesktopSwitch').length, 1);
  for (const sw of ['/PROJECTS=', '/PORT=']) {
    assert.match(installer, new RegExp(`Push "${sw}"\\n\\s*Call ParseValueSwitch`));
  }
});
