// The projects root: validation before setup downloads anything, and
// persistence as the user environment variable PROJECTS_ROOT, which cc's
// launcher honours over its default (installer contract C10).
import fs from 'node:fs';
import path from 'node:path';
import { expandVars, getEnv, readUserEnv, writeUserEnv } from './toolchain.mjs';

const w = path.win32;

// Mirrors the launcher's default (C10): %USERPROFILE%\code-conductor.
export const defaultProjectsRoot = (env) => w.join(getEnv(env, 'USERPROFILE') || '', 'code-conductor');

const trimSlash = (p) => (w.parse(p).root === p ? p : p.replace(/[\\/]+$/, ''));
const same = (a, b) => trimSlash(w.normalize(a)).toLowerCase() === trimSlash(w.normalize(b)).toLowerCase();

// The normalised root, or a throw saying why it cannot be used.
export function checkProjectsRoot(root, installDir, { stat = fs.statSync } = {}) {
  if (!/^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(root)) {
    throw new Error(`the projects folder must be an absolute path: ${root}`);
  }
  const norm = trimSlash(w.normalize(root));
  const inst = trimSlash(w.normalize(installDir)).toLowerCase();
  const low = norm.toLowerCase();
  if (low === inst || low.startsWith(`${inst}\\`)) {
    throw new Error(`the projects folder ${norm} must not be inside the install directory ${installDir}, which uninstall deletes`);
  }
  let st = null;
  try { st = stat(norm); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  if (st && !st.isDirectory()) throw new Error(`the projects folder ${norm} exists but is not a directory`);
  return norm;
}

// Creates `root` and saves it as the user PROJECTS_ROOT, but only when it
// differs from what the launcher would already use (the user value, expanded,
// else an inherited PROJECTS_ROOT, else the default): an unchanged root leaves
// the registry, and any %VAR% form in it, alone. A value of another kind than
// String/ExpandString fails closed (readUserEnv).
export async function persistProjectsRoot(root, { runPs, env, log, mkdir = (d) => fs.mkdirSync(d, { recursive: true }) }) {
  mkdir(root);
  const cur = await readUserEnv('PROJECTS_ROOT', { runPs });
  const set = cur.exists && cur.value ? expandVars(cur.value, env) : null;
  const effective = set || getEnv(env, 'PROJECTS_ROOT') || defaultProjectsRoot(env);
  if (same(root, effective)) {
    log(`projects: ${root} (unchanged)`);
    return false;
  }
  await writeUserEnv('PROJECTS_ROOT', root, cur.exists ? cur.kind : 'String', { runPs });
  log(`projects: set the user PROJECTS_ROOT to ${root}`);
  return true;
}
