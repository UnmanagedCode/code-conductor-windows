// The user-environment scripts (Path, PROJECTS_ROOT) run by real PowerShell through runPowerShell, with
// HKCU\Environment swapped for a fake key backed by a JSON file, so the
// encoding path (-EncodedCommand, base64 over stdin/stdout, JSON in both
// directions) is exercised end to end on any OS:
//   PWSH=<path to pwsh> node --test tests/userpath.pwsh.test.mjs
// On a Windows host run it with PWSH=powershell.exe: Windows PowerShell 5.1
// is what setup.mjs runs, so that is the variant that counts there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addToUserPath, userEnvScript, readUserEnv, writeUserEnv } from '../src/toolchain.mjs';
import { runPowerShell } from '../src/setup.mjs';

const t = process.env.PWSH ? test : test.skip.bind(test);

// A `$k` whose GetValue/GetValueKind/SetValue read and write `file`
// ({<name>: {exists, kind, value}}, UTF-8 JSON); `GetValue` honours its default.
function fakeKey(file) {
  const f = file.replace(/'/g, "''");
  const load = `([IO.File]::ReadAllText('${f}', [Text.Encoding]::UTF8) | ConvertFrom-Json)`;
  return `$k = New-Object psobject
$k | Add-Member ScriptMethod GetValue { param($n, $d, $o) $s = (${load}).$n; if ($s -and $s.exists) { $s.value } else { $d } }
$k | Add-Member ScriptMethod GetValueKind { param($n) [Microsoft.Win32.RegistryValueKind]((${load}).$n).kind }
$k | Add-Member ScriptMethod SetValue { param($n, $v, $kind) $h = [ordered]@{}; foreach ($p in ${load}.PSObject.Properties) { $h[$p.Name] = $p.Value }; $h[$n] = @{ exists = $true; kind = [string]$kind; value = $v }; [IO.File]::WriteAllText('${f}', (ConvertTo-Json -Compress -Depth 5 -InputObject $h), (New-Object Text.UTF8Encoding $false)) }`;
}

// `state` is {<name>: {exists, kind, value}}; read(name) returns that entry.
function setup(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pwsh-'));
  const file = path.join(dir, 'Environment.json');
  fs.writeFileSync(file, JSON.stringify(state));
  const runPs = (script, input) => {
    const op = script === userEnvScript('read') ? 'read' : script === userEnvScript('write') ? 'write' : null;
    assert.ok(op, 'a userEnvScript');
    return runPowerShell(userEnvScript(op, fakeKey(file)), input, process.env.PWSH);
  };
  return { runPs, read: (name = 'Path') => JSON.parse(fs.readFileSync(file, 'utf8'))[name], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const pathState = (kind, value) => ({ Path: { exists: true, kind, value } });

t('non-ASCII Path entries round-trip through real PowerShell, kind kept', { timeout: 60_000 }, async () => {
  const existing = 'C:\\Users\\Müller\\bin;D:\\工具;%USERPROFILE%\\Ångström';
  const dir = 'C:\\Users\\Müller\\.local\\bin';
  const s = setup(pathState('ExpandString', existing));
  try {
    assert.equal(await addToUserPath(dir, { runPs: s.runPs, env: {} }), true);
    assert.deepEqual(s.read(), { exists: true, kind: 'ExpandString', value: `${existing};${dir}` });
    assert.equal(await addToUserPath(dir, { runPs: s.runPs, env: {} }), false);
  } finally { s.cleanup(); }
});

// Past the 32767-char command-line limit, so only stdin/stdout can carry it.
t('a Path of thousands of entries (non-ASCII, %VAR%) round-trips untruncated', { timeout: 120_000 }, async () => {
  const kinds = [(i) => `C:\\Users\\Müller\\tools\\dir${i}`, (i) => `%USERPROFILE%\\工具\\${i}`, (i) => `D:\\Ångström\\bin${i}`];
  const existing = Array.from({ length: 3000 }, (_, i) => kinds[i % kinds.length](i)).join(';');
  assert.ok(existing.length > 32767);
  const dir = 'C:\\Users\\Müller\\.local\\bin';
  const s = setup(pathState('ExpandString', existing));
  try {
    assert.equal(await addToUserPath(dir, { runPs: s.runPs, env: {} }), true);
    const after = s.read();
    assert.equal(after.kind, 'ExpandString');
    assert.equal(after.value.length, existing.length + 1 + dir.length);
    assert.equal(after.value, `${existing};${dir}`);
    assert.equal(await addToUserPath(dir, { runPs: s.runPs, env: {} }), false);
  } finally { s.cleanup(); }
});

t('an absent Path is created as ExpandString; a Binary one is refused', { timeout: 60_000 }, async () => {
  const s = setup({});
  try {
    assert.equal(await addToUserPath('C:\\n', { runPs: s.runPs, env: {} }), true);
    assert.deepEqual(s.read(), { exists: true, kind: 'ExpandString', value: 'C:\\n' });
  } finally { s.cleanup(); }
  const b = setup(pathState('Binary', [67, 0]));
  try {
    await assert.rejects(addToUserPath('C:\\n', { runPs: b.runPs, env: {} }), /unexpected kind Binary/);
  } finally { b.cleanup(); }
});

t('a script failure exits 1 with its message on stderr', { timeout: 60_000 }, async () => {
  const r = await runPowerShell(userEnvScript('write', '$k = $null'), '', process.env.PWSH);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HKCU\\Environment could not be opened/);
  const s = setup(pathState('String', 'C:\\a'));
  try {
    const bad = await s.runPs(userEnvScript('write'), Buffer.from(JSON.stringify({ name: 'Path', value: 'C:\\x', kind: 'Binary' })).toString('base64'));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /refusing to write Path as kind Binary/);
    assert.equal(s.read().value, 'C:\\a');
  } finally { s.cleanup(); }
});

// Invariant: the value name travels through real PowerShell as data: a
// non-ASCII PROJECTS_ROOT round-trips, is addressed by name (Path untouched)
// and an absent one reads as absent.
t('a non-ASCII PROJECTS_ROOT writes and reads back through real PowerShell, beside an untouched Path', { timeout: 60_000 }, async () => {
  const s = setup(pathState('String', 'C:\\a'));
  try {
    const root = 'D:\\Projekte\\Müller\\工具';
    assert.deepEqual(await readUserEnv('PROJECTS_ROOT', { runPs: s.runPs }), { exists: false });
    await writeUserEnv('PROJECTS_ROOT', root, 'String', { runPs: s.runPs });
    assert.deepEqual(await readUserEnv('PROJECTS_ROOT', { runPs: s.runPs }), { exists: true, kind: 'String', value: root });
    assert.deepEqual(s.read('PROJECTS_ROOT'), { exists: true, kind: 'String', value: root });
    assert.equal(s.read('Path').value, 'C:\\a');
  } finally { s.cleanup(); }
});
