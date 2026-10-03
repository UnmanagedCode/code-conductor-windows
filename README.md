# code-conductor-windows

The per-user Windows installer for [code-conductor](https://github.com/UnmanagedCode/code-conductor) (cc). It is a single `code-conductor-setup-<version>-<commit>.exe` that installs cc for the current Windows user, with no admin rights. That covers a bundled Node, a git checkout that cc's in-app self-update keeps current, Git for Windows and Claude Code (if missing), and a Start-menu entry. The exe is built on Linux from a chosen cc source and ref.

What this installer relies on from cc (launcher path and exit codes, install layout, checkout recipe, tool locations, projects root) is cc's **installer contract**: [▶ cc docs/windows.md#installer-contract](https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract). This README does not restate it.

## Install (for users)

Run `code-conductor-setup-<version>-<commit>.exe` as the user who will use cc. The installer:

1. Stops a running cc first, after asking (through the launcher's `--status`/`--stop`, whose results also go to `logs\setup.log`). It aborts if something answers on cc's port but can't be identified. If the existing `app\` has no launcher and something answers `/api/health`, it aborts rather than removing `node\` under a running server.
2. Replaces `node\` with the bundled Node.
3. Runs `setup.mjs` with that Node. Progress goes to the details pane and `logs\setup.log`:
   - **Git for Windows:** uses an existing Git that has Git Bash (`git.exe` in `<root>\cmd` or `<root>\bin`, plus `<root>\bin\bash.exe`), found on PATH, in `%LOCALAPPDATA%\Programs\Git` or in `%ProgramFiles%\Git`. A `git.exe` in `usr\bin`, `mingw64\bin` or `mingw32\bin` (Git's "optional Unix tools" PATH option) does not count. Setup uses the install's own `cmd\git.exe` (else `bin\git.exe`). Otherwise it downloads the pinned Git installer, checks its sha256 and installs it per-user (`/CURRENTUSER`, Git's `cmd` on PATH).
   - **Claude Code:** uses `claude.exe` on PATH (an npm `.cmd` shim does not count) or `%USERPROFILE%\.local\bin\claude.exe`. Otherwise it runs the official installer (`irm https://claude.ai/install.ps1 | iex`).
   - **User PATH:** appends `%USERPROFILE%\.local\bin` to the user `Path` (`HKCU\Environment`) if it is absent, keeping the existing entries, any `%VAR%` in them, non-ASCII characters and the value's kind (a new value is `REG_EXPAND_SZ`). It reads and writes through PowerShell's .NET registry API, not `reg.exe`, whose output is in the console code page. A Path it cannot read, or of a kind other than `REG_SZ`/`REG_EXPAND_SZ`, aborts setup rather than being overwritten.
   - **Checkout:** a fresh install clones the bundled cc into `app\` (LF line endings, `core.autocrlf=false`, branch with upstream) and points `origin` at GitHub. An existing checkout is compared with the bundled commit and never reset, since it may hold self-updated or local commits:

     | Existing `HEAD` | Result |
     |---|---|
     | equal | kept |
     | behind | fast-forwarded; kept if local changes block it (self-update handles it later) |
     | ahead | kept |
     | diverged (neither contains the other) | **setup fails**, naming both commits |

     A kept checkout must contain the launcher (`bin\windows-launch.mjs`), or setup fails. To recover from either failure, uninstall, then run the installer again; your projects root is kept.
   - **Dependencies:** `npm ci` in `app\` with the bundled Node and npm.
4. Only if setup succeeded: writes `code-conductor.exe` (the Start-menu stub), `uninstall.exe`, the Start-menu shortcut and the Apps & features entry (`DisplayVersion` `<version>+<commit>`), and shows the finish page. A failed setup aborts the installer (exit code 2 when silent) and points at `logs\setup.log`.

The finish page offers to launch cc. Sign in to Claude once with `claude auth login` in a terminal if you haven't already. Your projects live in `%USERPROFILE%\code-conductor` unless `PROJECTS_ROOT` is set.

### Install layout

```
%LOCALAPPDATA%\Programs\code-conductor\
  code-conductor.exe   Start-menu stub: runs node\node.exe app\bin\windows-launch.mjs
  uninstall.exe
  node\                bundled Node + npm (the pinned version)
  app\                 the cc git checkout (origin = GitHub, branch main)
  logs\                setup.log (installer), server.log / server.prev.log (launcher)
```

### Launcher

`code-conductor.exe` is a windowless stub that runs cc's own launcher, `app\bin\windows-launch.mjs`, with the bundled Node. The launcher ships in the cc checkout and updates with it. It reuses a running cc, or starts the server and opens the UI; on failure the stub shows its message in a message box. The launcher's modes, server environment and logs are documented in [cc docs/windows.md](https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#launcher).

### Update

- **cc:** the in-app self-update runs `git pull --ff-only` + `npm install` in `app\` and restarts.
- **Re-running an installer** (newer or the same) stops cc, replaces `node\`, and fast-forwards `app\` to its bundled commit. An older installer keeps `app\` at its newer `HEAD`; a diverged `app\` fails the install (see Checkout above).

### Node is never updated by self-update

In-app self-update moves only `app\`. The bundled `node\` stays at the version this installer pinned until a newer installer release is run; every install replaces `node\`. When a cc update raises its `engines.node` past the bundled Node, cc warns at boot. Run the newest installer to fix it.

### Uninstall

Apps & features → code-conductor, or `uninstall.exe` (`/S` for silent). It stops a running cc, then removes the install directory, the Start-menu shortcut and the Apps & features entry. It **keeps** your projects root (and its `.code-conductor` store), Git for Windows, Claude Code and the user PATH entry.

### Limitations

- The exe is unsigned, so SmartScreen warns on first run ("More info" → "Run anyway").
- Downloads (Git, Claude Code's installer) use Node's `fetch`, which ignores the system proxy.
- The installer and stub use NSIS's default icon.
- Signing in to Claude is manual: `claude auth login`.

## Technical

### Stack and layout

Node 24 ESM scripts, no npm dependencies; NSIS (`makensis`) compiles the installer on Linux.

```
src/
  build.mjs       builds the exe: fetch cc, check the contract, bundle, stage, makensis
  setup.mjs       install-time CLI the installer runs with the bundled Node
  toolchain.mjs   Git/claude detection and the user PATH write (used by setup.mjs)
  pins.json       pinned Node zip and Git for Windows installer (version, url, sha256)
  installer.nsi   installer + uninstaller
  launcher.nsi    Start-menu stub (code-conductor.exe)
tests/            node:test suites; zip.mjs is a minimal zip writer for fixtures
build/            output exes; build/cache/ holds downloaded pins (gitignored)
```

`setup.mjs` runs before any cc checkout exists (it needs Git to clone), so it cannot import cc. `toolchain.mjs` therefore carries copies of the launcher's env/PATH helpers and claude detection. Its `detectGit` accepts only Git layouts cc's `resolveGitBash` also finds, which is contract clause C8.

### Build

Needs Node ≥ 24, `git`, `unzip`, `tar` and NSIS (`sudo apt install nsis`).

```
npm run build                                   # cc main from GitHub
npm run build -- --ref v0.2.0                   # a tag
npm run build -- --source <path to a cc checkout> --ref my-branch
MAKENSIS=/path/to/makensis npm run build
```

| Flag / env | Default | Meaning |
|---|---|---|
| `--source` | `https://github.com/UnmanagedCode/code-conductor.git` | URL or local path to fetch cc from |
| `--ref` | `main` | Branch, tag or full sha to bundle (tried as a source branch, then a tag, then a commit) |
| `--branch` | `main` | Branch the installed checkout is created on and self-update follows |
| `--remote-url` | the GitHub URL | `origin` of the installed checkout, independent of `--source` |
| `MAKENSIS` | `makensis` | NSIS compiler |

Output: `build/code-conductor-setup-<package.json version>-<short8 sha>.exe`. Reproducible in its inputs (pinned Node, the resolved cc commit, this repo's sources), not byte-identical.

`src/build.mjs` (`buildInstaller`):

1. Checks the tools are present.
2. Fetches all branches and tags of `--source` into a temp bare repo.
3. Resolves `--ref`; an unknown ref is refused.
4. Checks the commit against the contract and refuses with the contract URL if any check fails:
   - `bin/windows-launch.mjs` (`LAUNCHER_REL`), `package.json`, `package-lock.json` and `LICENSE` exist;
   - no `package-lock.json` `packages` entry has `hasInstallScript` (`npm ci` gets no build toolchain);
   - `version` is a string;
   - `engines.node` has the form `>=N[.N[.N]]` and the pinned Node satisfies it.
5. Warns if the commit is not on `--branch` at the source: self-update would then report ahead or diverged.
6. Stages `cc.bundle` (the commit as `refs/heads/<branch>`, verified), `LICENSE` from the ref, this repo's shipped `src/` files, and the pinned Node (from `build/cache/` when its sha256 matches, else downloaded and checked).
7. Runs `makensis` on `launcher.nsi`, then `installer.nsi`. The defines are `VERSION`, `COMMIT`, `BRANCH`, `REMOTE_URL`, `STAGE`, `OUTFILE` and `LAUNCHER` (`bin\windows-launch.mjs`).

### Pins

`src/pins.json` holds `node` (the Windows x64 zip, bundled at build time) and `git` (the Git for Windows 64-bit installer, downloaded at install time only when Git is missing). Each pin has a `version`, a `url` and a `sha256`. To bump one:

- **Node:** take the `node-v<version>-win-x64.zip` line from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`. It must still satisfy cc's `engines.node`; the build refuses otherwise.
- **Git:** take the `Git-<version>-64-bit.exe` asset's sha256 digest from the `git-for-windows/git` GitHub release.

### Tests

```
npm test                                        # node --test, no network, no deps
RUN_WIN_INSTALLER_BUILD=1 node --test tests/build.real.test.mjs
PWSH=<path to pwsh> node --test tests/userpath.pwsh.test.mjs
```

On a Windows host, run the PowerShell suite with `PWSH=powershell.exe`. Windows PowerShell 5.1 is what `setup.mjs` runs, so that variant is the one that counts there; pwsh 7 on Linux only proves the scripts and the encoding path.

```
$env:PWSH = 'powershell.exe'; node --test tests/userpath.pwsh.test.mjs   # in a PowerShell prompt
```

| File | Covers |
|---|---|
| `tests/build.test.mjs` | `buildInstaller` against a synthetic cc-shaped repo with a fake `makensis`: ref resolution (branch/tag/sha), contract refusals, the off-branch warning, the stage contents and defines, the pinned-zip cache |
| `tests/build.real.test.mjs` | Gated by `RUN_WIN_INSTALLER_BUILD=1`: a real fetch, the pinned Node download and real `makensis` produce a PE exe over 20 MB. `CC_SOURCE`/`CC_REF` override the GitHub default and `main` |
| `tests/checkout.test.mjs` | `checkout()` with real git: fresh clone (LF, upstream, origin); equal/behind/ahead/diverged classification; a dirty tree kept; a kept checkout without the launcher refused |
| `tests/setup.test.mjs` | `ensureGit` sha refusal, `downloadWithRetry` |
| `tests/toolchain.test.mjs` | `detectGit` layouts (mirroring cc's C8, plus the rejected `usr\bin`/`mingw64\bin`), `detectClaude`, `findOnPath`, `addToUserPath` against a fake of the PowerShell channel (base64 JSON both ways, exit 1 with localized stderr, non-ASCII round-trip) |
| `tests/userpath.pwsh.test.mjs` | Gated by `PWSH`: the real user-Path scripts run by real PowerShell through `runPowerShell`, with `HKCU\Environment` swapped for a fake key, so the encoding path is exercised end to end (non-ASCII round-trip, a multi-KB Path past the command-line limit, kinds, failure exit codes) |
