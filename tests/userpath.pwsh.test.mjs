// The user Path scripts run by real PowerShell through runPowerShell, with
// HKCU\Environment swapped for a fake key backed by a JSON file, so the
// encoding path (-EncodedCommand, base64 over stdin/stdout, JSON in both
// directions) is exercised end to end on any OS:
//   PWSH=<path to pwsh or powershell.exe> node --test tests/userpath.pwsh.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addToUserPath, userPathScript } from '../src/toolchain.mjs';
import { runPowerShell } from '../src/setup.mjs';

const t = process.env.PWSH ? test : test.skip.bind(test);

// A `$k` whose GetValue/GetValueKind/SetValue read and write `file`
// ({exists, kind, value}, UTF-8 JSON); `GetValue` honours its default.
function fakeKey(file) {
  const f = file.replace(/'/g, "''");
  const load = `([IO.File]::ReadAllText('${f}', [Text.Encoding]::UTF8) | ConvertFrom-Json)`;
  return `$k = New-Object psobject
$k | Add-Member ScriptMethod GetValue { param($n, $d, $o) $s = ${load}; if ($s.exists) { $s.value } else { $d } }
$k | Add-Member ScriptMethod GetValueKind { param($n) [Microsoft.Win32.RegistryValueKind](${load}).kind }
$k | Add-Member ScriptMethod SetValue { param($n, $v, $kind) [IO.File]::WriteAllText('${f}', (ConvertTo-Json -Compress -InputObject @{ exists = $true; kind = [string]$kind; value = $v }), (New-Object Text.UTF8Encoding $false)) }`;
}

function setup(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pwsh-'));
  const file = path.join(dir, 'Environment.json');
  fs.writeFileSync(file, JSON.stringify(state));
  const runPs = (script, input) => {
    const op = script === userPathScript('read') ? 'read' : script === userPathScript('write') ? 'write' : null;
    assert.ok(op, 'a userPathScript');
    return runPowerShell(userPathScript(op, fakeKey(file)), input, process.env.PWSH);
  };
  return { runPs, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

t('non-ASCII Path entries round-trip through real PowerShell, kind kept', { timeout: 60_000 }, async () => {
  const existing = 'C:\\Users\\Müller\\bin;D:\\工具;%USERPROFILE%\\Ångström';
  const dir = 'C:\\Users\\Müller\\.local\\bin';
  const s = setup({ exists: true, kind: 'ExpandString', value: existing });
  try {
    assert.equal(await addToUserPath(dir, { runPs: s.runPs, env: {} }), true);
    assert.deepEqual(s.read(), { exists: true, kind: 'ExpandString', value: `${existing};${dir}` });
    assert.equal(await addToUserPath(dir, { runPs: s.runPs, env: {} }), false);
  } finally { s.cleanup(); }
});

t('an absent Path is created as ExpandString; a Binary one is refused', { timeout: 60_000 }, async () => {
  const s = setup({ exists: false });
  try {
    assert.equal(await addToUserPath('C:\\n', { runPs: s.runPs, env: {} }), true);
    assert.deepEqual(s.read(), { exists: true, kind: 'ExpandString', value: 'C:\\n' });
  } finally { s.cleanup(); }
  const b = setup({ exists: true, kind: 'Binary', value: [67, 0] });
  try {
    await assert.rejects(addToUserPath('C:\\n', { runPs: b.runPs, env: {} }), /unexpected kind Binary/);
  } finally { b.cleanup(); }
});

t('a script failure exits 1 with its message on stderr', { timeout: 60_000 }, async () => {
  const r = await runPowerShell(userPathScript('write', '$k = $null'), '', process.env.PWSH);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HKCU\\Environment could not be opened/);
  const s = setup({ exists: true, kind: 'String', value: 'C:\\a' });
  try {
    const bad = await s.runPs(userPathScript('write'), Buffer.from(JSON.stringify({ value: 'C:\\x', kind: 'Binary' })).toString('base64'));
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /refusing to write Path as kind Binary/);
    assert.equal(s.read().value, 'C:\\a');
  } finally { s.cleanup(); }
});
