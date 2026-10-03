import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkout } from '../src/setup.mjs';
import { CONTRACT_URL } from '../src/contract.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const LAUNCHER = 'bin/windows-launch.mjs';

// seed (working repo) -> origin.git (stands in for GitHub, the installer's
// source). The seed passes the installer contract; `commit` advances origin.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-checkout-'));
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(path.join(seed, 'bin'), { recursive: true });
  git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"code-conductor","version":"1.0.0","engines":{"node":">=24"}}\n');
  fs.writeFileSync(path.join(seed, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"":{"name":"code-conductor"}}}\n');
  fs.writeFileSync(path.join(seed, 'LICENSE'), 'license\n');
  fs.writeFileSync(path.join(seed, 'conductor.sh'), '#!/usr/bin/env bash\nexec true\n');
  fs.writeFileSync(path.join(seed, 'bin', 'windows-launch.mjs'), '// launcher\n');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const commit = (msg, file = 'f.txt') => {
    fs.appendFileSync(path.join(seed, file), `${msg}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', msg);
    git(seed, 'push', '-q', '-f', origin, 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  commit('c1');
  // Windows git installers default to a global autocrlf=true.
  const globalCfg = path.join(root, 'gitconfig');
  fs.writeFileSync(globalCfg, '[core]\n\tautocrlf = true\n[user]\n\temail = t@t\n\tname = t\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
  const dir = path.join(root, 'app');
  const lines = [];
  const sleeps = [];
  // The arguments checkout() takes, with logs and sleeps captured.
  const args = (extra = {}) => ({
    git: 'git', source: origin, dir, branch: 'main', nodeVersion: '24.21.0', env,
    log: (m) => lines.push(m), sleep: async (ms) => { sleeps.push(ms); }, ...extra,
  });
  return { root, seed, origin, dir, env, lines, sleeps, args, commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const localCfg = (t, key) => execFileSync('git', ['-C', t.dir, 'config', '--local', key], { encoding: 'utf8', env: t.env }).trim();
// A commit made inside the installed checkout (a local or self-updated one).
const commitIn = (t, msg, file = 'local.txt') => {
  fs.appendFileSync(path.join(t.dir, file), `${msg}\n`);
  execFileSync('git', ['-C', t.dir, 'add', '-A'], { env: t.env });
  execFileSync('git', ['-C', t.dir, 'commit', '-q', '-m', msg], { env: t.env });
  return git(t.dir, 'rev-parse', 'HEAD');
};
// A checkout config() snapshot: what a failing checkout must leave alone.
const config = (t) => [git(t.dir, 'remote', 'get-url', 'origin'), localCfg(t, 'core.autocrlf')];
const scriptedLock = JSON.stringify({ packages: { '': {}, 'node_modules/native': { hasInstallScript: true } } });

// Invariant: a fresh install clones the source's branch with upstream, sets
// origin to the source, LF endings and autocrlf=false, a clean tree; it logs
// the installed version, full sha, branch and source, and returns {commit, version}.
test('fresh checkout: branch + upstream + origin + LF + clean; installed line logged and returned', async () => {
  const t = setup();
  try {
    const r = await checkout(t.args());
    const sha = git(t.dir, 'rev-parse', 'HEAD');
    assert.deepEqual(r, { commit: sha, version: '1.0.0' });
    assert.ok(t.lines.includes(`checkout: installed cc 1.0.0 at ${sha} (main from ${t.origin})`), t.lines.join('\n'));
    assert.equal(git(t.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(t.dir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.equal(git(t.dir, 'remote', 'get-url', 'origin'), t.origin);
    assert.equal(localCfg(t, 'core.autocrlf'), 'false');
    assert.equal(git(t.dir, 'status', '--porcelain'), '');
    assert.match(execFileSync('git', ['-C', t.dir, 'ls-files', '--eol', 'conductor.sh'], { encoding: 'utf8', env: t.env }), /w\/lf/);
    assert.ok(!fs.readFileSync(path.join(t.dir, 'conductor.sh'), 'utf8').includes('\r'));
  } finally { t.cleanup(); }
});

// Invariant: a re-run fast-forwards to a newer source tip and keeps HEAD
// when the source tip is older (rewound), leaving the tree clean.
test('rerun with a newer source fast-forwards; an older source tip keeps HEAD', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const c1 = git(t.dir, 'rev-parse', 'HEAD');
    const c2 = t.commit('c2');
    await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), c2);
    git(t.seed, 'push', '-q', '-f', t.origin, `${c1}:refs/heads/main`);
    await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), c2);
    assert.equal(git(t.dir, 'status', '--porcelain'), '');
  } finally { t.cleanup(); }
});

// Invariant: a non-empty directory that is not a checkout is refused, untouched.
test('a non-empty directory that is not a checkout is refused', async () => {
  const t = setup();
  try {
    fs.mkdirSync(t.dir);
    fs.writeFileSync(path.join(t.dir, 'x'), 'x');
    await assert.rejects(checkout(t.args()), /not a git checkout/);
    assert.ok(fs.existsSync(path.join(t.dir, 'x')));
  } finally { t.cleanup(); }
});

// Invariant: local changes that block the fast-forward keep HEAD, the install
// continues and origin is still set; the self-update promise is logged.
test('a dirty checkout that blocks the fast-forward is kept and the install continues', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const c1 = git(t.dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(t.dir, 'f.txt'), 'local edit\n');
    t.commit('c2'); // touches f.txt too, so the ff would overwrite the edit
    await checkout(t.args({ source: t.origin }));
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), c1);
    assert.match(fs.readFileSync(path.join(t.dir, 'f.txt'), 'utf8'), /local edit/);
    assert.ok(t.lines.some((l) => /NOT fast-forwarded/.test(l)));
    assert.ok(t.lines.some((l) => /self-update will fast-forward it/.test(l)));
    assert.equal(git(t.dir, 'remote', 'get-url', 'origin'), t.origin);
  } finally { t.cleanup(); }
});

// Invariant: against the latest main, equal is kept, behind is
// fast-forwarded and ahead is kept, each with its own log line.
test('existing checkout classified against the latest main: equal kept, behind fast-forwarded, ahead kept', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const c1 = git(t.dir, 'rev-parse', 'HEAD');

    t.lines.length = 0;
    await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), c1);
    assert.ok(t.lines.some((l) => /already at the latest main/.test(l)), t.lines.join('\n'));

    const c2 = t.commit('c2');
    t.lines.length = 0;
    await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), c2);
    assert.ok(t.lines.some((l) => l.includes(`fast-forwarding ${c1.slice(0, 8)} -> ${c2.slice(0, 8)}`)), t.lines.join('\n'));

    const mine = commitIn(t, 'local work');
    t.lines.length = 0;
    await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), mine);
    assert.ok(t.lines.some((l) => l.includes(`kept ${mine.slice(0, 8)}; it is ahead of the latest main ${c2.slice(0, 8)}`)), t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: a diverged checkout fails loudly naming both commits and the
// recovery, and is left untouched.
test('a diverged checkout fails loudly, naming both commits and the recovery, and is left untouched', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const mine = commitIn(t, 'local work');
    const tip = t.commit('c2');
    const err = await checkout(t.args()).then(() => assert.fail('kept'), (e) => e);
    assert.match(err.message, /has diverged/);
    assert.ok(err.message.includes(mine.slice(0, 8)) && err.message.includes(tip.slice(0, 8)), err.message);
    assert.match(err.message, /uninstall code-conductor .*then run this installer again; your projects in the projects root are kept/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), mine);
    assert.equal(git(t.dir, 'status', '--porcelain'), '');
  } finally { t.cleanup(); }
});

// Invariant: a kept checkout (ahead of the source) that has lost the launcher
// fails with the contract message and the recovery, naming its HEAD.
test('a kept checkout without the launcher fails with the contract message', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    execFileSync('git', ['-C', t.dir, 'rm', '-q', LAUNCHER], { env: t.env });
    const ahead = commitIn(t, 'drop the launcher');
    const err = await checkout(t.args()).then(() => assert.fail('kept'), (e) => e);
    assert.ok(err.message.includes(`is at ${ahead.slice(0, 8)}, which does not meet the installer contract`), err.message);
    assert.ok(err.message.includes(`${LAUNCHER} is missing`) && err.message.includes(CONTRACT_URL), err.message);
    assert.match(err.message, /uninstall code-conductor/);
  } finally { t.cleanup(); }
});

// Invariant: a fast-forward blocked by local changes, that leaves a HEAD
// without the launcher, fails and does not promise the in-app self-update.
test('a blocked fast-forward that then fails the contract does not promise a self-update', async () => {
  const t = setup();
  try {
    git(t.seed, 'rm', '-q', LAUNCHER);
    t.commit('pre-move');
    // Not through checkout(): it would refuse a launcher-less tip.
    execFileSync('git', ['clone', '-q', t.origin, t.dir], { env: t.env });
    fs.appendFileSync(path.join(t.dir, 'f.txt'), 'local edit\n');
    fs.mkdirSync(path.join(t.seed, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(t.seed, LAUNCHER), '// launcher\n');
    t.commit('moved'); // touches f.txt too, so the ff is blocked
    await assert.rejects(checkout(t.args()), /bin\/windows-launch\.mjs is missing/);
    assert.ok(t.lines.some((l) => /NOT fast-forwarded/.test(l)), t.lines.join('\n'));
    assert.equal(t.lines.some((l) => /self-update/.test(l)), false, t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: a failing existing checkout keeps its git config (origin,
// autocrlf) rather than having the source's origin written over it, whether it
// fails as diverged or because its own HEAD no longer meets the contract (a
// local commit adding an install-script package).
test('a failing existing checkout keeps its git config: origin and autocrlf untouched', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    execFileSync('git', ['-C', t.dir, 'config', 'core.autocrlf', 'input'], { env: t.env });
    execFileSync('git', ['-C', t.dir, 'remote', 'set-url', 'origin', 'https://example.invalid/mine.git'], { env: t.env });
    const before = config(t);

    fs.writeFileSync(path.join(t.dir, 'package-lock.json'), scriptedLock);
    commitIn(t, 'native dep');
    const err = await checkout(t.args()).then(() => assert.fail('kept'), (e) => e);
    assert.match(err.message, /package-lock\.json has packages with install scripts: node_modules\/native/);
    assert.match(err.message, /uninstall code-conductor/);
    assert.deepEqual(config(t), before);

    t.commit('c2'); // the local commit is now diverged from the source
    await assert.rejects(checkout(t.args()), /has diverged/);
    assert.deepEqual(config(t), before);
  } finally { t.cleanup(); }
});

// Invariant: when the latest main fails the contract on a fresh install,
// setup fails citing the problem and the contract URL, and no partial app\
// is left to confuse a re-run.
test('fresh install whose tip fails the contract fails and removes app\\', async () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.seed, 'package-lock.json'), scriptedLock);
    const tip = t.commit('native dep');
    const err = await checkout(t.args()).then(() => assert.fail('installed'), (e) => e);
    assert.match(err.message, /package-lock\.json has packages with install scripts: node_modules\/native/);
    assert.ok(err.message.includes(CONTRACT_URL) && err.message.includes(tip.slice(0, 8)), err.message);
    assert.equal(fs.existsSync(t.dir), false);
  } finally { t.cleanup(); }
});

// Invariant: on an existing install a tip that fails the contract is not
// applied: HEAD is kept, the problems are logged, and the install continues
// (so a re-run for Node/Git/claude works while the newest cc is uninstallable).
test('existing install behind a tip that fails the contract keeps HEAD, warns, and continues', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const c1 = git(t.dir, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(t.seed, 'package.json'), '{"name":"code-conductor","version":"2.0.0","engines":{"node":">=99"}}\n');
    const tip = t.commit('needs a newer node');
    t.lines.length = 0;
    const r = await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), c1);
    assert.deepEqual(r, { commit: c1, version: '1.0.0' });
    assert.ok(t.lines.some((l) => l.includes(`the latest main ${tip.slice(0, 8)} does not meet the installer contract; kept ${c1.slice(0, 8)}`)), t.lines.join('\n'));
    assert.ok(t.lines.some((l) => /does not satisfy engines\.node ">=99"/.test(l)), t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: an unreachable source fails after exactly 3 attempts with
// backoff between them (2 s, 4 s), the failure named in the message; a fresh
// run leaves no app\ and an existing checkout is untouched.
test('an unreachable source fails after 3 attempts, fresh and existing', async () => {
  const t = setup();
  try {
    const gone = path.join(t.root, 'does-not-exist.git');
    const attempts = () => t.lines.filter((l) => /fetching cc from .* failed \(attempt \d\/3/.test(l)).length;
    await assert.rejects(checkout(t.args({ source: gone })), /fetching cc main from .* failed after 3 attempts \(exit \d+\)\. Check the network connection/);
    assert.equal(attempts(), 3);
    assert.deepEqual(t.sleeps, [2000, 4000]);
    assert.equal(fs.existsSync(t.dir), false);

    await checkout(t.args());
    const before = git(t.dir, 'rev-parse', 'HEAD');
    t.lines.length = 0;
    t.sleeps.length = 0;
    await assert.rejects(checkout(t.args({ source: gone })), /failed after 3 attempts/);
    assert.equal(attempts(), 3);
    assert.deepEqual(t.sleeps, [2000, 4000]);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), before);
    assert.equal(git(t.dir, 'remote', 'get-url', 'origin'), t.origin);
  } finally { t.cleanup(); }
});

// Invariant: clone and fetch run with git's credential prompts disabled, so
// a bad URL fails instead of hanging the installer.
test('network git commands run with GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never', async () => {
  const t = setup();
  try {
    const record = path.join(t.root, 'env.log');
    const wrapper = path.join(t.root, 'git-wrapper');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$1 $GIT_TERMINAL_PROMPT $GCM_INTERACTIVE" >> '${record}'\nexec '${realGit}' "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    await checkout(t.args({ git: wrapper }));
    t.commit('c2');
    await checkout(t.args({ git: wrapper }));
    const seen = fs.readFileSync(record, 'utf8').trim().split('\n');
    const net = seen.filter((l) => /^(-c|fetch) /.test(l));
    assert.equal(net.length, 2, seen.join('\n'));
    for (const l of net) assert.match(l, / 0 never$/);
  } finally { t.cleanup(); }
});

// A checkout whose commits (two on a feature branch, one on main, merged with
// a merge commit) all exist on origin's main as rebased copies, the way an
// older installer's bundled feature-branch tip ended up after the branch was
// rebased onto main and merged. Run after `checkout(t.args())`. `ownChange`
// puts a hand-made edit into the merge; `upstreamFile` is what the tip's
// extra commit touches. Returns {head, tip}.
function rebased(t, { upstreamFile = 'f.txt', ownChange = false } = {}) {
  const inDir = (...a) => execFileSync('git', ['-C', t.dir, ...a], { encoding: 'utf8', env: t.env }).trim();
  inDir('checkout', '-q', '-b', 'feat');
  const a = commitIn(t, 'a', 'a.txt');
  const b = commitIn(t, 'b', 'b.txt');
  inDir('checkout', '-q', 'main');
  const c = commitIn(t, 'c', 'c.txt');
  if (ownChange) {
    inDir('merge', '-q', '--no-commit', '--no-ff', 'feat');
    fs.appendFileSync(path.join(t.dir, 'c.txt'), 'by hand\n');
    inDir('add', '-A');
    inDir('commit', '-q', '-m', 'merge feat');
  } else {
    inDir('merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
  }
  const head = inDir('rev-parse', 'HEAD');
  t.commit('u1', upstreamFile);
  git(t.seed, 'fetch', '-q', t.dir, 'feat', 'main');
  git(t.seed, 'cherry-pick', a, b, c);
  git(t.seed, 'push', '-q', '-f', t.origin, 'main');
  return { head, tip: git(t.seed, 'rev-parse', 'HEAD') };
}

// Invariant: a diverged checkout whose off-tip commits (merges included) all
// have rebased copies on the latest main is moved to it in place: branch,
// upstream and untracked files are kept, the old HEAD is kept as the
// pre-install/<sha8> branch, and the move (naming that branch) is logged.
test('a diverged checkout whose commits are all on the latest main as rebased copies is moved to it', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head, tip } = rebased(t);
    // the seed holds both histories (the checkout has not fetched the tip yet)
    assert.ok(!git(t.seed, 'cherry', tip, head).includes('+'));
    assert.equal(git(t.seed, 'rev-list', '--merges', `${tip}..${head}`).split('\n').length, 1);
    fs.writeFileSync(path.join(t.dir, 'notes.txt'), 'mine\n');
    t.lines.length = 0;
    const r = await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), tip);
    assert.equal(r.commit, tip);
    assert.equal(git(t.dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(t.dir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.equal(fs.readFileSync(path.join(t.dir, 'notes.txt'), 'utf8'), 'mine\n');
    assert.equal(git(t.dir, 'rev-parse', `pre-install/${head.slice(0, 8)}`), head);
    assert.ok(t.lines.some((l) => l.includes(`moving ${head.slice(0, 8)} -> ${tip.slice(0, 8)}`) && l.includes(`pre-install/${head.slice(0, 8)}`)), t.lines.join('\n'));
    assert.ok(t.lines.some((l) => l.startsWith('checkout: installed cc ')), t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: one commit with no patch-equivalent on the latest main keeps the
// checkout diverged: it fails as before, names the commit in the log, and
// leaves HEAD and the git config untouched.
test('a rebased checkout with one genuine extra commit still fails as diverged', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head, tip } = rebased(t);
    const mine = commitIn(t, 'mine', 'mine.txt');
    const before = config(t);
    t.lines.length = 0;
    const err = await checkout(t.args()).then(() => assert.fail('moved'), (e) => e);
    assert.match(err.message, /has diverged/);
    assert.ok(err.message.includes(mine.slice(0, 8)) && err.message.includes(tip.slice(0, 8)), err.message);
    assert.match(err.message, /uninstall code-conductor .*then run this installer again/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), mine);
    assert.notEqual(mine, head);
    assert.deepEqual(config(t), before);
    assert.ok(t.lines.some((l) => l.includes('commits not on it:') && l.includes(mine.slice(0, 8))), t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: a merge whose recorded tree differs from re-merging its parents
// holds hand-made changes that git cherry cannot see, so it is not moved.
test('a rebased checkout whose merge has changes of its own fails as diverged', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t, { ownChange: true });
    t.lines.length = 0;
    await assert.rejects(checkout(t.args()), /has diverged/);
    assert.match(t.lines.join('\n'), /merge [0-9a-f]{8} has changes of its own/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
  } finally { t.cleanup(); }
});

// Invariant: uncommitted edits to tracked files are never carried to another
// base: a dirty rebased checkout fails as diverged with the edit, HEAD and
// the git config intact.
test('a dirty rebased checkout is not moved and fails as diverged', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t);
    fs.appendFileSync(path.join(t.dir, 'a.txt'), 'wip\n');
    const before = config(t);
    t.lines.length = 0;
    await assert.rejects(checkout(t.args()), /has diverged/);
    assert.match(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), /wip\n$/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
    assert.deepEqual(config(t), before);
    assert.ok(t.lines.some((l) => l.includes('uncommitted changes')), t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: an untracked file at a path the tip tracks blocks the move
// (reset --keep refuses rather than overwrite it): the file's content and HEAD
// are intact and setup fails as diverged.
test('an untracked file in the tip\'s way blocks the move', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t, { upstreamFile: 'new.txt' });
    fs.writeFileSync(path.join(t.dir, 'new.txt'), 'precious\n');
    t.lines.length = 0;
    await assert.rejects(checkout(t.args()), /has diverged/);
    assert.equal(fs.readFileSync(path.join(t.dir, 'new.txt'), 'utf8'), 'precious\n');
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
    assert.match(t.lines.join('\n'), /NOT moved/);
  } finally { t.cleanup(); }
});

// Invariant: a recoverable checkout is not moved to a tip that fails the
// contract: HEAD is kept with a warning and the install continues.
test('a rebased checkout behind a tip that fails the contract keeps HEAD, warns, and continues', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t);
    fs.writeFileSync(path.join(t.seed, 'package.json'), '{"name":"code-conductor","version":"2.0.0","engines":{"node":">=99"}}\n');
    const tip = t.commit('needs a newer node');
    t.lines.length = 0;
    const r = await checkout(t.args());
    assert.deepEqual(r, { commit: head, version: '1.0.0' });
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
    assert.ok(t.lines.some((l) => l.includes(`the latest main ${tip.slice(0, 8)} does not meet the installer contract; kept ${head.slice(0, 8)}`)), t.lines.join('\n'));
  } finally { t.cleanup(); }
});

// Invariant: patch-equivalence is the rule, not content survival: a local
// commit whose patch upstream applied and later reverted is still moved (the
// content leaves the tree), and the pre-install branch then holds it.
test('a commit whose patch upstream applied and reverted is moved, and the backup branch holds it', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const x = commitIn(t, 'x', 'x.txt');
    // the same patch as the local commit, under another message (so another sha)
    fs.writeFileSync(path.join(t.seed, 'x.txt'), 'x\n');
    git(t.seed, 'add', '-A');
    git(t.seed, 'commit', '-q', '-m', 'y');
    git(t.seed, 'rm', '-q', 'x.txt');
    git(t.seed, 'commit', '-q', '-m', 'revert y');
    git(t.seed, 'push', '-q', '-f', t.origin, 'main');
    const tip = git(t.seed, 'rev-parse', 'HEAD');
    await checkout(t.args());
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), tip);
    assert.ok(!fs.existsSync(path.join(t.dir, 'x.txt')));
    assert.equal(git(t.dir, 'rev-parse', `pre-install/${x.slice(0, 8)}`), x);
    assert.equal(git(t.dir, 'show', `pre-install/${x.slice(0, 8)}:x.txt`), 'x');
  } finally { t.cleanup(); }
});

// Invariant: recovery never rewrites another branch: HEAD on a branch other
// than the installed one fails as diverged, naming the branch, HEAD unchanged.
test('a rebased checkout on another branch is not moved and fails as diverged', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t);
    git(t.dir, 'checkout', '-q', '-b', 'other');
    t.lines.length = 0;
    await assert.rejects(checkout(t.args()), /has diverged/);
    assert.match(t.lines.join('\n'), /on branch other, not main/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
    assert.equal(git(t.dir, 'rev-parse', 'main'), head);
  } finally { t.cleanup(); }
});

// Invariant: an existing pre-install/<sha8> at another commit stops the move
// (nothing is overwritten): fails as diverged, HEAD unchanged.
test('a pre-install branch at another commit blocks the move', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t);
    git(t.dir, 'branch', `pre-install/${head.slice(0, 8)}`, 'HEAD~1');
    t.lines.length = 0;
    await assert.rejects(checkout(t.args()), /has diverged/);
    assert.match(t.lines.join('\n'), /already exists at another commit/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
  } finally { t.cleanup(); }
});

// Invariant: a git failure while judging recoverability is a not-recoverable
// reason (the standard diverged error), not a bare throw.
test('a git failure while judging recoverability gives the diverged error', async () => {
  const t = setup();
  try {
    await checkout(t.args());
    const { head } = rebased(t);
    const real = t.args();
    // fail `git cherry` only
    const wrapper = path.join(t.root, 'git-wrap.sh');
    fs.writeFileSync(wrapper, '#!/bin/sh\n[ "$1" = cherry ] && exit 3\nexec git "$@"\n', { mode: 0o755 });
    t.lines.length = 0;
    await assert.rejects(checkout({ ...real, git: wrapper }), /has diverged/);
    assert.match(t.lines.join('\n'), /git cherry failed \(exit 3\)/);
    assert.equal(git(t.dir, 'rev-parse', 'HEAD'), head);
  } finally { t.cleanup(); }
});
