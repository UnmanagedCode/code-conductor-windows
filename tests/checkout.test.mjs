import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkout } from '../src/setup.mjs';

// As the installer passes it: the LAUNCHER define, Windows separators.
const LAUNCHER = 'bin\\windows-launch.mjs';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

// seed (working repo) -> origin.git (stands in for GitHub) and bundles cut
// from the seed at chosen commits.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-checkout-'));
  const seed = path.join(root, 'seed');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(seed);
  git(seed, '-c', 'init.defaultBranch=main', 'init', '-q');
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(seed, 'package.json'), '{"name":"code-conductor","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(seed, 'conductor.sh'), '#!/usr/bin/env bash\nexec true\n');
  fs.mkdirSync(path.join(seed, 'bin'));
  fs.writeFileSync(path.join(seed, 'bin', 'windows-launch.mjs'), '// launcher\n');
  const commit = (msg, file = 'f.txt') => {
    fs.appendFileSync(path.join(seed, file), `${msg}\n`);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', msg);
  };
  commit('c1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, 'push', '-q', origin, 'main');
  const bundle = (name) => {
    const f = path.join(root, name);
    git(seed, 'bundle', 'create', f, 'refs/heads/main');
    return f;
  };
  // Windows git installers default to a global autocrlf=true.
  const globalCfg = path.join(root, 'gitconfig');
  fs.writeFileSync(globalCfg, '[core]\n\tautocrlf = true\n[user]\n\temail = t@t\n\tname = t\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg };
  return { root, seed, origin, bundle, commit, env, log: () => {}, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('fresh checkout: branch + upstream + origin URL + LF + clean', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    await checkout({ git: 'git', bundle: t.bundle('b1.bundle'), dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: t.log, env: t.env });
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.equal(git(dir, 'remote', 'get-url', 'origin'), t.origin);
    assert.equal(execFileSync('git', ['-C', dir, 'config', '--local', 'core.autocrlf'], { encoding: 'utf8', env: t.env }).trim(), 'false');
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.match(execFileSync('git', ['-C', dir, 'ls-files', '--eol', 'conductor.sh'], { encoding: 'utf8', env: t.env }), /w\/lf/);
    assert.ok(!fs.readFileSync(path.join(dir, 'conductor.sh'), 'utf8').includes('\r'));
  } finally { t.cleanup(); }
});

test('rerun with a newer bundle fast-forwards; an older one keeps HEAD', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: t.log, env: t.env };
    const b1 = t.bundle('b1.bundle');
    await checkout({ ...args, bundle: b1 });
    const c1 = git(dir, 'rev-parse', 'HEAD');
    t.commit('c2');
    const b2 = t.bundle('b2.bundle');
    await checkout({ ...args, bundle: b2 });
    const c2 = git(dir, 'rev-parse', 'HEAD');
    assert.notEqual(c2, c1);
    assert.equal(c2, git(t.seed, 'rev-parse', 'HEAD'));
    await checkout({ ...args, bundle: b1 });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c2);
    await checkout({ ...args, bundle: b2 });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c2);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally { t.cleanup(); }
});

test('a non-empty directory that is not a checkout is refused', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x'), 'x');
    await assert.rejects(checkout({ git: 'git', bundle: t.bundle('b.bundle'), dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: t.log, env: t.env }), /not a git checkout/);
  } finally { t.cleanup(); }
});

test('a dirty checkout that blocks the fast-forward is kept and the install continues', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const lines = [];
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: (m) => lines.push(m), env: t.env };
    await checkout({ ...args, bundle: t.bundle('b1.bundle') });
    const c1 = git(dir, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(dir, 'f.txt'), 'local edit\n');
    t.commit('c2'); // touches f.txt too, so the ff would overwrite the edit
    await checkout({ ...args, bundle: t.bundle('b2.bundle') });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c1);
    assert.match(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), /local edit/);
    assert.ok(lines.some((l) => /NOT fast-forwarded/.test(l) && /self-update/.test(l)));
    assert.equal(git(dir, 'remote', 'get-url', 'origin'), t.origin);
  } finally { t.cleanup(); }
});

// A commit made inside the installed checkout (a local or self-updated one).
const commitIn = (t, dir, msg, file = 'local.txt') => {
  fs.appendFileSync(path.join(dir, file), `${msg}\n`);
  execFileSync('git', ['-C', dir, 'add', '-A'], { env: t.env });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', msg], { env: t.env });
  return git(dir, 'rev-parse', 'HEAD');
};

test('existing checkout classified against the bundle: equal kept, behind fast-forwarded, ahead kept', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const lines = [];
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: (m) => lines.push(m), env: t.env };
    const b1 = t.bundle('b1.bundle');
    await checkout({ ...args, bundle: b1 });
    const c1 = git(dir, 'rev-parse', 'HEAD');

    lines.length = 0;
    await checkout({ ...args, bundle: b1 });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c1);
    assert.ok(lines.some((l) => /already at the installer's commit/.test(l)), lines.join('\n'));

    t.commit('c2');
    lines.length = 0;
    await checkout({ ...args, bundle: t.bundle('b2.bundle') });
    const c2 = git(t.seed, 'rev-parse', 'HEAD');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), c2);
    assert.ok(lines.some((l) => l.includes(`fast-forwarding ${c1.slice(0, 8)} -> ${c2.slice(0, 8)}`)), lines.join('\n'));

    const mine = commitIn(t, dir, 'local work');
    lines.length = 0;
    await checkout({ ...args, bundle: t.bundle('b2.bundle') });
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mine);
    assert.ok(lines.some((l) => l.includes(`kept ${mine.slice(0, 8)}; it is ahead of the installer's commit ${c2.slice(0, 8)}`)), lines.join('\n'));
  } finally { t.cleanup(); }
});

test('a diverged checkout fails loudly, naming both commits and the recovery, and is left untouched', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: t.log, env: t.env };
    await checkout({ ...args, bundle: t.bundle('b1.bundle') });
    const mine = commitIn(t, dir, 'local work');
    t.commit('c2');
    const tip = git(t.seed, 'rev-parse', 'HEAD');
    const err = await checkout({ ...args, bundle: t.bundle('b2.bundle') }).then(() => assert.fail('kept'), (e) => e);
    assert.match(err.message, /has diverged/);
    assert.ok(err.message.includes(mine.slice(0, 8)) && err.message.includes(tip.slice(0, 8)), err.message);
    assert.match(err.message, /uninstall code-conductor .*then run this installer again; your projects in the projects root are kept/);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), mine);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally { t.cleanup(); }
});

test('a kept checkout without the launcher fails (ahead, or a blocked fast-forward)', async () => {
  const t = setup();
  try {
    const dir = path.join(t.root, 'app');
    const args = { git: 'git', dir, branch: 'main', remoteUrl: t.origin, launcher: LAUNCHER, log: t.log, env: t.env };
    const b1 = t.bundle('b1.bundle');
    await checkout({ ...args, bundle: b1 });
    execFileSync('git', ['-C', dir, 'rm', '-q', 'bin/windows-launch.mjs'], { env: t.env });
    const ahead = commitIn(t, dir, 'drop the launcher');
    await assert.rejects(checkout({ ...args, bundle: b1 }),
      (e) => e.message.includes(`is at ${ahead.slice(0, 8)}, which has no ${LAUNCHER}`) && /uninstall code-conductor/.test(e.message));
  } finally { t.cleanup(); }

  // An old checkout without the launcher whose fast-forward to one with it is blocked.
  const u = setup();
  try {
    git(u.seed, 'rm', '-q', 'bin/windows-launch.mjs');
    u.commit('pre-move');
    const dir = path.join(u.root, 'app');
    const args = { git: 'git', dir, branch: 'main', remoteUrl: u.origin, launcher: LAUNCHER, log: u.log, env: u.env };
    await assert.rejects(checkout({ ...args, bundle: u.bundle('old.bundle') }), /which has no bin\\windows-launch\.mjs/);
    fs.appendFileSync(path.join(dir, 'f.txt'), 'local edit\n');
    fs.mkdirSync(path.join(u.seed, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(u.seed, 'bin', 'windows-launch.mjs'), '// launcher\n');
    u.commit('moved'); // touches f.txt too, so the ff is blocked
    await assert.rejects(checkout({ ...args, bundle: u.bundle('new.bundle') }), /which has no bin\\windows-launch\.mjs/);
  } finally { u.cleanup(); }
});
