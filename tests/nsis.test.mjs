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

const fnBody = (name) => {
  const a = installer.indexOf(`Function ${name}\n`);
  assert.ok(a >= 0, `Function ${name} not found`);
  return installer.slice(a, installer.indexOf('\nFunctionEnd', a));
};

// Invariant: a refused projects folder or port is refused before anything is stopped.
test('Section Install checks the inputs and aborts before StopRunning', () => {
  const sec = installer.slice(installer.indexOf('Section "Install"'), installer.indexOf('Section "Uninstall"'));
  const check = sec.indexOf('Call CheckInputs');
  const stop = sec.indexOf('!insertmacro StopRunning');
  assert.ok(check > 0 && check < stop);
  const abort = sec.indexOf('Abort', check);
  assert.ok(abort > check && abort < stop);
});

// Invariant: the check does not depend on the old or missing $INSTDIR\node.
test('CheckInputs runs setup --check with the node.exe StageSetup extracts', () => {
  assert.ok(fnBody('CheckInputs').includes('"$PLUGINSDIR\\node.exe" "$PLUGINSDIR\\setup.mjs" --check'));
  assert.ok(fnBody('StageSetup').includes('File "${STAGE}\\node\\node.exe"'));
});

// Invariant: the wizard validates both pages with setup's own check.
test('both page leaves call CheckInputs', () => {
  assert.ok(fnBody('ProjectsPageLeave').includes('Call CheckInputs'));
  assert.ok(fnBody('PortPageLeave').includes('Call CheckInputs'));
  assert.match(installer, /!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ProjectsPageLeave\n!insertmacro MUI_PAGE_DIRECTORY/);
});

// Invariant: a silent startup refusal leaves a line in setup.log.
test('every Abort in .onInit is preceded by a SetupLog line, and the macro is defined first', () => {
  const body = fnBody('.onInit').split('\n');
  const aborts = body.flatMap((l, i) => (l.trim() === 'Abort' ? [i] : []));
  assert.equal(aborts.length, 2);
  for (const i of aborts) {
    const before = body.slice(0, i).reverse().find((l) => l.trim() && !l.includes('MessageBox'));
    assert.match(before, /!insertmacro SetupLog/);
  }
  assert.ok(installer.indexOf('!macro SetupLog') < installer.indexOf('Function .onInit'));
});

// Invariant: the check and setup see the same, backslash-doubled folder string.
test('every --projects-root passes $ProjectsArg', () => {
  const hits = installer.match(/--projects-root "[^\n]*/g) ?? [];
  assert.ok(hits.length >= 3);
  for (const h of hits) assert.match(h, /^--projects-root "\$ProjectsArg"/, h);
});

// Invariant: $ProjectsArg is computed (QuoteProjectsRoot) before the Install
// section and the directory page leave push it, so it is never an empty string.
test('Section Install and ProjectsPageLeave call QuoteProjectsRoot before pushing $ProjectsArg', () => {
  const sec = installer.slice(installer.indexOf('Section "Install"'), installer.indexOf('Section "Uninstall"'));
  for (const [name, body] of [['Section Install', sec], ['ProjectsPageLeave', fnBody('ProjectsPageLeave')]]) {
    const quote = body.indexOf('Call QuoteProjectsRoot');
    assert.ok(quote >= 0 && quote < body.indexOf('--projects-root "$ProjectsArg"'), name);
  }
});

// Invariant (static shape only; the NSIS runtime cannot run here): every
// trailing backslash of $ProjectsRoot is doubled into $ProjectsArg, which is
// what keeps a drive root such as D:\ from escaping the closing quote.
test('QuoteProjectsRoot doubles each trailing backslash', () => {
  const body = fnBody('QuoteProjectsRoot');
  assert.ok(body.includes('${DoWhile} $R4 == "\\"'));
  assert.ok(body.includes('StrCpy $R2 "$R2\\"'));
  assert.ok(body.includes('StrCpy $R3 $R3 -1'));
  assert.ok(body.includes('StrCpy $ProjectsArg "$ProjectsRoot$R2"'));
});
