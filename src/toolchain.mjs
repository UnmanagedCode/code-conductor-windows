// Tool detection and the user PATH write used by setup.mjs. Pure over an
// injected `env` / `exists` / `reg` so Linux tests exercise the Windows logic;
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
// null for any other git.exe (e.g. `mingw64\bin`), which the launcher's
// resolveGitBash would not map back to a Git Bash.
function gitRootOf(gitExe) {
  const dir = w.dirname(gitExe);
  return /^(cmd|bin)$/i.test(w.basename(dir)) ? w.dirname(dir) : null;
}

// Git counts only with its bundled `bin\bash.exe`: Git Bash is what claude
// needs on Windows, a bare git.exe is not enough. `cmdDir` is the found
// git.exe's directory, the one setup puts on PATH.
export function detectGit(env, exists = fs.existsSync) {
  const candidates = [];
  const onPath = findOnPath('git', env, exists);
  if (onPath) candidates.push(onPath);
  const local = getEnv(env, 'LOCALAPPDATA');
  if (local) candidates.push(w.join(local, 'Programs', 'Git', 'cmd', 'git.exe'));
  const pf = getEnv(env, 'ProgramFiles');
  if (pf) candidates.push(w.join(pf, 'Git', 'cmd', 'git.exe'));
  for (const gitExe of candidates) {
    if (!exists(gitExe)) continue;
    const root = gitRootOf(gitExe);
    if (root && exists(w.join(root, 'bin', 'bash.exe'))) return { gitExe, cmdDir: w.dirname(gitExe) };
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

function expandVars(value, env) {
  return value.replace(/%([^%]+)%/g, (m, n) => getEnv(env, n) ?? m);
}

// Append `dir` to the user PATH (HKCU\Environment\Path) iff absent. Goes
// through `reg.exe` rather than NSIS ReadRegStr (1024-char truncation) and
// writes REG_EXPAND_SZ without a shell so `%VAR%` entries stay literal.
// `reg(args)` -> {code, stdout, stderr}. Queries the whole key, which always
// exists, so a missing `Path` line is the only "absent"; any failed or
// unparseable query throws without writing, since writing would replace a
// Path we could not read. Matches value lines only, never message text,
// which Windows localizes.
export async function addToUserPath(dir, { reg, env = process.env }) {
  const q = await reg(['query', 'HKCU\\Environment']);          // the key always exists
  if (q.code !== 0) throw new Error(`reg query HKCU\\Environment failed (exit ${q.code}): ${(q.stderr || '').trim()}`);
  if (!/^HKEY_CURRENT_USER\\Environment\s*$/im.test(q.stdout)) throw new Error('reg query HKCU\\Environment succeeded but its output could not be parsed');
  const m = /^\s+Path\s+(REG_\w+)\s+(.*)$/im.exec(q.stdout);   // value lines are never localized
  if (m && !/^REG_(EXPAND_)?SZ$/.test(m[1])) throw new Error(`user Path has unexpected type ${m[1]}`);
  const current = m ? m[2].replace(/\r$/, '') : '';             // no Path line = absent
  const entries = splitPath(current);
  const norm = (s) => s.toLowerCase().replace(/[\\/]+$/, '');
  const want = norm(dir);
  if (entries.some((e) => norm(e) === want || norm(expandVars(e, env)) === want)) return false;
  const next = [...entries, dir].join(';');
  const r = await reg(['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', next, '/f']);
  if (r.code !== 0) throw new Error(`reg add HKCU\\Environment Path failed (exit ${r.code})`);
  return true;
}
