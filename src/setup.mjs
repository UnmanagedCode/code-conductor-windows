// Install-time CLI, run by the installer with the bundled node:
//   node setup.mjs --install-dir D --source URL --branch X --projects-root P
// Validates the projects folder, ensures Git for Windows and claude, puts
// claude's dir on the user PATH, clones/fast-forwards cc's latest <X> from URL
// into <D>\app and checks it against the installer contract, runs `npm ci`,
// and saves the projects folder as the user PROJECTS_ROOT.
// Progress goes to stdout (the installer's details pane) and logs\setup.log.
// Any failure exits nonzero, which aborts the installer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { detectGit, detectClaude, addToUserPath, envKey, getEnv, splitPath } from './toolchain.mjs';
import { contractProblems, contractError } from './contract.mjs';
import { checkProjectsRoot, persistProjectsRoot } from './projects.mjs';

const w = path.win32;

const stamp = (msg) => `[${new Date().toISOString()}] ${msg}`;

export function makeLogger(logFile) {
  if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  return (msg) => {
    const line = stamp(msg);
    console.log(line);
    if (logFile) fs.appendFileSync(logFile, line + '\n');
  };
}

// Spawn without a shell, stream output lines to `log`, resolve the exit code.
export function runLogged(log, file, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      const lines = out.split(/\r?\n/);
      out = lines.pop();
      for (const l of lines) if (l.trim()) log(`  ${l}`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (out.trim()) log(`  ${out}`);
      resolve(code ?? -1);
    });
  });
}

// Runs a PowerShell script with `input` on stdin -> {code, stdout, stderr}.
// The script goes in as -EncodedCommand (UTF-16LE), so no quoting or code
// page touches it. `exe` is injectable so a test can run real pwsh.
export function runPowerShell(script, input, exe = 'powershell.exe') {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const c = spawn(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', reject);
    c.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    // A child that exits without reading stdin (EPIPE) is judged by its exit
    // code: a write script that got no input fails to parse it and exits 1.
    c.stdin.on('error', () => {});
    c.stdin.end(input);
  });
}

async function mustRun(log, file, args, opts) {
  const code = await runLogged(log, file, args, opts);
  if (code !== 0) throw new Error(`${path.basename(file)} ${args.slice(0, 2).join(' ')} failed (exit ${code})`);
}

// Retried: the first attempt after a cold network is the one that times out.
export async function downloadWithRetry(url, { fetchFn = fetch, attempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchFn(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = new Error(`download ${url} failed (attempt ${i}/${attempts}): ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`);
      if (i < attempts) await sleep(2000 * i);
    }
  }
  throw last;
}

export async function ensureGit({ env, pin, log, fetchBuffer = (url) => downloadWithRetry(url), run = runLogged }) {
  const found = detectGit(env);
  if (found) {
    log(`git: found ${found.gitExe}`);
    return found;
  }
  log(`git: not found (or lacks Git Bash); downloading Git for Windows ${pin.version}`);
  const buf = await fetchBuffer(pin.url);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== pin.sha256) throw new Error(`git installer sha256 mismatch: got ${sha}, pinned ${pin.sha256}`);
  log(`git: sha256 OK (${sha})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-'));
  const exe = path.join(dir, path.basename(new URL(pin.url).pathname));
  fs.writeFileSync(exe, buf);
  try {
    const code = await run(log, exe, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/CURRENTUSER', '/NOCANCEL', '/SP-', '/o:PathOption=Cmd']);
    if (code !== 0) throw new Error(`Git installer exited ${code}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const after = detectGit(env);
  if (!after) throw new Error('Git for Windows installed but git.exe with bin\\bash.exe was not found');
  log(`git: installed ${after.gitExe}`);
  return after;
}

export async function ensureClaude({ env, log, run = runLogged }) {
  const found = detectClaude(env);
  if (found) {
    log(`claude: found ${found.claudeExe}`);
    return found;
  }
  log('claude: not found; running the official installer (https://claude.ai/install.ps1)');
  const code = await run(log, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
  if (code !== 0) throw new Error(`claude installer exited ${code}`);
  const home = getEnv(env, 'USERPROFILE');
  const claudeExe = w.join(home, '.local', 'bin', 'claude.exe');
  if (!fs.existsSync(claudeExe)) throw new Error(`claude installer finished but ${claudeExe} does not exist`);
  log(`claude: installed ${claudeExe}`);
  return { claudeExe, dir: w.dirname(claudeExe) };
}

const gitOut = (git, cwd, args, { raw = false, env } = {}) => new Promise((resolve) => {
  const c = spawn(git, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.on('close', (code) => resolve({ code: code ?? -1, stdout: raw ? stdout : stdout.trim() }));
});

// Why `HEAD` cannot be moved to `tip` when it has diverged, or null when it
// can: HEAD is on `branch` or detached (the move never rewrites another
// branch), every non-merge commit off the tip has a patch-equivalent (same
// patch-id, git cherry) in the tip's history, every off-tip merge re-merges
// its parents automatically to its own tree (cherry skips merges, so a
// hand-resolved one would hide work), and the tracked tree is clean. A
// patch-equivalent does not prove the content is still in the tip's tree
// (upstream may have reverted it), so the caller keeps the old HEAD as a branch.
async function offTip(git, dir, tip, branch, env) {
  const short = (sha) => sha.slice(0, 8);
  const cur = await gitOut(git, dir, ['symbolic-ref', '-q', '--short', 'HEAD'], { env });
  if (cur.code === 0 && cur.stdout !== branch) return `on branch ${cur.stdout}, not ${branch}`;
  if (cur.code > 1) return `git symbolic-ref failed (exit ${cur.code})`;
  const cherry = await gitOut(git, dir, ['cherry', tip, 'HEAD'], { env });
  if (cherry.code !== 0) return `git cherry failed (exit ${cherry.code})`;
  const unique = cherry.stdout.split('\n').filter((l) => l.startsWith('+')).map((l) => short(l.slice(2).trim()));
  if (unique.length) return `commits not on it: ${unique.join(', ')}`;
  const merges = await gitOut(git, dir, ['rev-list', '--merges', '--parents', `${tip}..HEAD`], { env });
  if (merges.code !== 0) return `git rev-list failed (exit ${merges.code})`;
  for (const line of merges.stdout.split('\n').filter(Boolean)) {
    const [m, ...parents] = line.split(' ');
    if (parents.length !== 2) return `merge ${short(m)} has more than two parents`;
    const tree = await gitOut(git, dir, ['merge-tree', '--write-tree', ...parents], { env });
    if (tree.code === 1) return `merge ${short(m)} has changes of its own`;
    if (tree.code !== 0) return `git merge-tree --write-tree failed (exit ${tree.code}; needs Git 2.38 or later)`;
    const own = await gitOut(git, dir, ['rev-parse', `${m}^{tree}`], { env });
    if (own.code !== 0 || tree.stdout.split('\n')[0] !== own.stdout) return `merge ${short(m)} has changes of its own`;
  }
  const dirty = await gitOut(git, dir, ['status', '--porcelain', '--untracked-files=no'], { env });
  if (dirty.code !== 0 || dirty.stdout) return 'uncommitted changes';
  return null;
}

// `read(rel)` for contractProblems: the file's text at `rev`, null if absent.
const showAt = (git, dir, rev, env) => async (rel) => {
  const r = await gitOut(git, dir, ['show', `${rev}:${rel}`], { raw: true, env });
  return r.code === 0 ? r.stdout : null;
};

const RECOVER = 'To recover, uninstall code-conductor (Apps & features), then run this installer again; your projects in the projects root are kept.';

// A network git command (clone/fetch), retried like downloadWithRetry: the
// first attempt after a cold network is the one that times out. `onFail`
// runs after each failed attempt (a fresh clone removes its partial dir).
async function retryGit(log, git, args, { cwd, env, sleep, attempts = 3, source, branch, onFail }) {
  let code;
  for (let i = 1; i <= attempts; i++) {
    code = await runLogged(log, git, args, { cwd, env });
    if (code === 0) return;
    log(`checkout: fetching cc from ${source} failed (attempt ${i}/${attempts}, exit ${code})`);
    await onFail?.();
    if (i < attempts) await sleep(2000 * i);
  }
  throw new Error(`fetching cc ${branch} from ${source} failed after ${attempts} attempts (exit ${code}). `
    + 'Check the network connection, then run the installer again. Git\'s output is above in this log.');
}

// Brings `dir` to cc's latest `branch` from `source`, then proves the result
// meets the installer contract (contractProblems, against `nodeVersion`).
// Fresh install: clone (LF, branch + upstream set); a tip that fails the
// contract fails setup and removes the clone. Existing checkout, against the
// fetched tip: equal or ahead -> kept; behind -> fast-forwarded (kept if
// local changes block it, or if the tip fails the contract, so a re-run for
// Node/Git/claude works while the newest cc is uninstallable); diverged ->
// moved to the tip (`reset --keep`, same tip-contract rule) when HEAD is on
// `branch` or detached, every off-tip commit has a patch-equivalent in the
// tip's history (git cherry), every off-tip merge is an automatic one and the
// tracked tree is clean; the old HEAD is first kept as pre-install/<sha8>.
// Refused otherwise, since it may hold the user's own work.
// Whatever HEAD ends up at must meet the contract, else setup fails. Git
// config (autocrlf, origin) is touched only once every check has passed.
// Returns {commit, version} of HEAD.
export async function checkout({ git, source, dir, branch, nodeVersion, log, env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  // A bad URL must fail, not prompt for credentials.
  const netEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const g = (args) => mustRun(log, git, args, { cwd: dir, env });
  // merge-base --is-ancestor: 0 yes, 1 no, anything else an error.
  const isAncestor = async (a, b) => {
    const code = await runLogged(log, git, ['merge-base', '--is-ancestor', a, b], { cwd: dir, env });
    if (code !== 0 && code !== 1) throw new Error(`git merge-base --is-ancestor ${a} ${b} failed (exit ${code})`);
    return code === 0;
  };
  const head = async (...flags) => (await gitOut(git, dir, ['rev-parse', ...flags, 'HEAD'], { env })).stdout;
  const fail = (rev, problems) => `${rev}, which does not meet the installer contract:${contractError(problems)}\n`;
  const diverged = (h, t) => new Error(`${dir} is at ${h}, which has diverged from the latest ${branch} ${t} (neither contains the other). `
    + `Setup does not reset it, since it may hold your own commits. ${RECOVER}`);
  let ffBlocked = false;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      throw new Error(`${dir} exists, is not a git checkout and is not empty`);
    }
    log(`checkout: cloning ${branch} from ${source} into ${dir}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await retryGit(log, git, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', '--branch', branch, source, dir],
      { env: netEnv, sleep, source, branch, onFail: () => fs.rmSync(dir, { recursive: true, force: true }) });
    const { problems } = await contractProblems(showAt(git, dir, 'HEAD', env), nodeVersion);
    if (problems.length) {
      const short = await head('--short=8');
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`The latest cc ${branch} (${short}) from ${source} cannot be installed: it does not meet the installer contract:${contractError(problems)}\n`
        + 'Try again later, or use a newer installer release.');
    }
  } else {
    log(`checkout: existing checkout at ${dir}`);
    await retryGit(log, git, ['fetch', source, branch], { cwd: dir, env: netEnv, sleep, source, branch });
    const same = await gitOut(git, dir, ['rev-parse', 'HEAD', 'FETCH_HEAD'], { env });
    const [headSha, tip] = same.stdout.split('\n');
    if (same.code !== 0 || !headSha || !tip) throw new Error(`git rev-parse HEAD FETCH_HEAD failed in ${dir} (exit ${same.code})`);
    const [h, t] = [headSha.slice(0, 8), tip.slice(0, 8)];
    // false (logged) when the tip fails the contract, so HEAD stays.
    const tipPasses = async () => {
      const { problems } = await contractProblems(showAt(git, dir, tip, env), nodeVersion);
      if (problems.length) {
        log(`checkout: the latest ${branch} ${t} does not meet the installer contract; kept ${h}:`);
        for (const p of problems) log(`  - ${p}`);
      }
      return problems.length === 0;
    };
    if (headSha === tip) {
      log(`checkout: already at the latest ${branch}`);
    } else if (await isAncestor(headSha, tip)) {
      if (await tipPasses()) {
        log(`checkout: fast-forwarding ${h} -> ${t}`);
        if ((await runLogged(log, git, ['merge', '--ff-only', tip], { cwd: dir, env })) !== 0) {
          log(`checkout: NOT fast-forwarded (local changes in the way); kept ${h}`);
          ffBlocked = true;
        }
      }
    } else if (await isAncestor(tip, headSha)) {
      log(`checkout: kept ${h}; it is ahead of the latest ${branch} ${t}`);
    } else {
      const why = await offTip(git, dir, tip, branch, env);
      if (why) {
        log(`checkout: ${h} cannot be moved to the latest ${branch} ${t}: ${why}`);
        throw diverged(h, t);
      }
      if (await tipPasses()) {
        const backup = `pre-install/${h}`;
        const have = await gitOut(git, dir, ['rev-parse', '-q', '--verify', `refs/heads/${backup}`], { env });
        if (have.code === 0 && have.stdout !== headSha) {
          log(`checkout: branch ${backup} already exists at another commit; kept ${h}`);
          throw diverged(h, t);
        }
        if (have.code !== 0 && (await runLogged(log, git, ['branch', backup, headSha], { cwd: dir, env })) !== 0) {
          log(`checkout: could not create branch ${backup}; kept ${h}`);
          throw diverged(h, t);
        }
        log(`checkout: moving ${h} -> ${t}: it has diverged from the latest ${branch}, but each of its commits has a patch-equivalent in its history; the old ${h} is kept as branch ${backup}`);
        if ((await runLogged(log, git, ['reset', '--keep', tip], { cwd: dir, env })) !== 0) {
          log(`checkout: NOT moved (untracked files in the way); kept ${h}`);
          throw diverged(h, t);
        }
      }
    }
  }
  const { problems, version } = await contractProblems(showAt(git, dir, 'HEAD', env), nodeVersion);
  const commit = await head();
  if (problems.length) throw new Error(`${dir} is at ${fail(commit.slice(0, 8), problems)}${RECOVER}`);
  await g(['config', 'core.autocrlf', 'false']);
  await g(['remote', 'set-url', 'origin', source]);
  if (ffBlocked) log('checkout: in-app self-update will fast-forward it once the local changes are resolved');
  log(`checkout: installed cc ${version} at ${commit} (${branch} from ${source})`);
  return { commit, version };
}

export async function main(argv, env = process.env) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  for (const k of ['install-dir', 'source', 'branch', 'projects-root']) {
    if (!args[k]) throw new Error(`missing --${k}`);
  }
  const installDir = args['install-dir'];
  const log = makeLogger(path.join(installDir, 'logs', 'setup.log'));
  const pins = JSON.parse(fs.readFileSync(new URL('./pins.json', import.meta.url), 'utf8'));
  // Before any download: a bad folder should fail in seconds.
  const projectsRoot = checkProjectsRoot(args['projects-root'], installDir);

  const git = await ensureGit({ env, pin: pins.git, log });
  const claude = await ensureClaude({ env, log });
  const home = getEnv(env, 'USERPROFILE');
  if (home && claude.dir.toLowerCase() === w.join(home, '.local', 'bin').toLowerCase()) {
    const added = await addToUserPath(claude.dir, { runPs: runPowerShell, env });
    log(added ? `path: added ${claude.dir} to the user PATH` : `path: ${claude.dir} already on the user PATH`);
  }

  const appDir = path.join(installDir, 'app');
  // Bundled node first, so `npm ci` and its children use the bundled npm.
  const pathKey = envKey(env, 'PATH') || 'Path';
  const toolEnv = { ...env, [pathKey]: [w.join(installDir, 'node'), git.cmdDir, ...splitPath(getEnv(env, 'PATH'))].join(';') };
  // The running node is the bundled one.
  await checkout({ git: git.gitExe, source: args.source, dir: appDir, branch: args.branch, nodeVersion: process.versions.node, log, env: toolEnv });

  log('npm: npm ci');
  const npmCli = path.join(installDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mustRun(log, path.join(installDir, 'node', 'node.exe'), [npmCli, 'ci'], { cwd: appDir, env: toolEnv });
  await persistProjectsRoot(projectsRoot, { runPs: runPowerShell, env, log });
  log('setup complete');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(stamp(`setup failed: ${e.message}`));
    try { fs.appendFileSync(path.join(process.argv[process.argv.indexOf('--install-dir') + 1], 'logs', 'setup.log'), `${stamp(`setup failed: ${e.stack}`)}\n`); } catch {}
    process.exit(1);
  });
}
