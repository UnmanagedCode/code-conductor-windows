// Tool detection and the user PATH write used by setup.mjs. Pure over an
// injected `env` / `exists` / `runPs` so Linux tests exercise the Windows logic;
// every path op is `path.win32`.
//
// Intentional duplication: setup.mjs runs before any cc checkout exists (it
// needs Git to clone), so it cannot import cc. envKey/getEnv/findOnPath/
// detectClaude are copies of cc's bin/windows-launch.mjs ones, and detectGit
// is a stricter cousin of cc's resolveGitBash. The cross-repo invariant
// (everything detectGit accepts, the launcher also finds) is clause C8 of
// https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract
import fs from 'node:fs';
import path from 'node:path';

const w = path.win32;

// Windows env names are case-insensitive; an injected plain object is not.
export function envKey(env, name) {
  const lower = name.toLowerCase();
  return Object.keys(env).find((k) => k.toLowerCase() === lower);
}
export function getEnv(env, name) {
  const k = envKey(env, name);
  return k === undefined ? undefined : env[k];
}

export const splitPath = (value) => (value || '').split(';').filter(Boolean);

// `name.exe` on PATH. Only `.exe` counts: an npm `.cmd` shim is not a binary
// cc can spawn directly.
export function findOnPath(name, env, exists = fs.existsSync) {
  for (const dir of splitPath(getEnv(env, 'PATH'))) {
    const candidate = w.join(dir.replace(/^"|"$/g, ''), `${name}.exe`);
    if (exists(candidate)) return candidate;
  }
  return null;
}

// Git's install root from a `<root>\cmd\git.exe` or `<root>\bin\git.exe`;
// null for any other git.exe. That includes `usr\bin` and `mingw64\bin`
// (Git's "optional Unix tools" PATH option): putting those first on setup's
// PATH would put MSYS tools ahead of System32.
function gitRootOf(gitExe) {
  const dir = w.dirname(gitExe);
  if (!/^(cmd|bin)$/i.test(w.basename(dir))) return null;
  const root = w.dirname(dir);
  return /^(usr|mingw64|mingw32)$/i.test(w.basename(root)) ? null : root;
}

// Git counts only with its bundled `bin\bash.exe`: Git Bash is what claude
// needs on Windows, a bare git.exe is not enough. Like the launcher, the
// git.exe used is the install's own `cmd\git.exe`, else its `bin\git.exe`;
// `cmdDir` is its directory, the one setup puts on PATH.
export function detectGit(env, exists = fs.existsSync) {
  const candidates = [];
  for (const dir of splitPath(getEnv(env, 'PATH'))) candidates.push(w.join(dir.replace(/^"|"$/g, ''), 'git.exe'));
  const local = getEnv(env, 'LOCALAPPDATA');
  if (local) candidates.push(w.join(local, 'Programs', 'Git', 'cmd', 'git.exe'));
  const pf = getEnv(env, 'ProgramFiles');
  if (pf) candidates.push(w.join(pf, 'Git', 'cmd', 'git.exe'));
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const root = gitRootOf(candidate);
    if (!root || !exists(w.join(root, 'bin', 'bash.exe'))) continue;
    const gitExe = ['cmd', 'bin'].map((d) => w.join(root, d, 'git.exe')).find(exists);
    return { gitExe, cmdDir: w.dirname(gitExe) };
  }
  return null;
}

export function detectClaude(env, exists = fs.existsSync) {
  const onPath = findOnPath('claude', env, exists);
  if (onPath) return { claudeExe: onPath, dir: w.dirname(onPath) };
  const home = getEnv(env, 'USERPROFILE');
  if (home) {
    const claudeExe = w.join(home, '.local', 'bin', 'claude.exe');
    if (exists(claudeExe)) return { claudeExe, dir: w.dirname(claudeExe) };
  }
  return null;
}

// The user Path (HKCU\Environment\Path) is read and written by PowerShell
// through .NET's registry API, never reg.exe: reg.exe prints in the console
// code page, so a non-ASCII entry would come back mangled and be written back
// corrupted. Only base64 of UTF-8 JSON crosses the pipes, so no code page
// applies. `read` prints {exists, kind, value} (value unexpanded); `write`
// takes {value, kind} on stdin, writes it and reads it back to verify. Any
// failure exits 1 with the message on stderr.
const PS_OPEN = {
  read: "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)",
  write: "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
};
const PS_BODY = {
  read: `
$v = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
if ($null -eq $v) { $o = @{ exists = $false } } else { $o = @{ exists = $true; kind = $k.GetValueKind('Path').ToString(); value = $v } }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $o))))`,
  write: `
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
if ($req.kind -cne 'String' -and $req.kind -cne 'ExpandString') { throw "refusing to write Path as kind $($req.kind)" }
if ($req.value -isnot [string]) { throw 'refusing to write a non-string Path' }
$k.SetValue('Path', $req.value, [Microsoft.Win32.RegistryValueKind]$req.kind)
$back = $k.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
if ($back -cne $req.value -or $k.GetValueKind('Path').ToString() -cne $req.kind) { throw 'Path read back differs from what was written' }`,
};

// The PowerShell script for `op` ('read' | 'write'). `openKey` is the line
// that sets `$k`; tests swap it for a fake key.
export function userPathScript(op, openKey = PS_OPEN[op]) {
  return `$ErrorActionPreference = 'Stop'
try {
${openKey}
if ($null -eq $k) { throw 'HKCU\\Environment could not be opened' }
${PS_BODY[op]}
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
exit 0
`;
}

function expandVars(value, env) {
  return value.replace(/%([^%]+)%/g, (m, n) => getEnv(env, n) ?? m);
}

// Append `dir` to the user Path iff absent, keeping its kind (a new value is
// REG_EXPAND_SZ, so `%VAR%` entries stay literal) and never truncating.
// `runPs(script, input)` -> {code, stdout, stderr} runs a userPathScript.
// Fails closed: a failed or unparseable read, or a kind other than
// REG_SZ/REG_EXPAND_SZ, throws without writing, since writing would replace
// a Path we could not read. Only an absent value counts as empty.
export async function addToUserPath(dir, { runPs, env = process.env }) {
  const q = await runPs(userPathScript('read'), '');
  if (q.code !== 0) throw new Error(`reading the user Path failed (exit ${q.code}): ${(q.stderr || '').trim()}`);
  const out = (q.stdout || '').trim();
  let cur = null;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(out)) {
    try { cur = JSON.parse(Buffer.from(out, 'base64').toString('utf8')); } catch { cur = null; }
  }
  if (typeof cur?.exists !== 'boolean') throw new Error('reading the user Path succeeded but its output could not be parsed');
  if (cur.exists && cur.kind !== 'String' && cur.kind !== 'ExpandString') throw new Error(`user Path has unexpected kind ${cur.kind}`);
  if (cur.exists && typeof cur.value !== 'string') throw new Error('user Path read back as a non-string');

  const entries = splitPath(cur.exists ? cur.value : '');
  const norm = (s) => s.toLowerCase().replace(/[\\/]+$/, '');
  const want = norm(dir);
  if (entries.some((e) => norm(e) === want || norm(expandVars(e, env)) === want)) return false;
  const req = { value: [...entries, dir].join(';'), kind: cur.exists ? cur.kind : 'ExpandString' };
  const r = await runPs(userPathScript('write'), Buffer.from(JSON.stringify(req), 'utf8').toString('base64'));
  if (r.code !== 0) throw new Error(`writing the user Path failed (exit ${r.code}): ${(r.stderr || '').trim()}`);
  return true;
}
