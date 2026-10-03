# code-conductor-windows

The per-user Windows installer for [code-conductor](https://github.com/UnmanagedCode/code-conductor) (cc). It is a single `code-conductor-setup-<version>.exe` that installs the latest cc `main` from GitHub at install time, for the current Windows user, with no admin rights. That covers a bundled Node, a git checkout that cc's in-app self-update keeps current, Git for Windows and Claude Code (if missing), a projects folder of your choice and a Start-menu entry. The exe is built on Linux and is not tied to a cc commit.

What this installer relies on from cc (launcher path and exit codes, install layout, checkout recipe, tool locations, projects root) is cc's **installer contract**: [▶ cc docs/windows.md#installer-contract](https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract). This README does not restate it.

## Install (for users)

Run `code-conductor-setup-<version>.exe` as the user who will use cc. It needs network access to GitHub and the npm registry. The installer:

1. Stops a running cc first, after asking (through the launcher's `--status`/`--stop`, whose results also go to `logs\setup.log`). It aborts if something answers on cc's port but can't be identified. If the existing `app\` has no launcher and something answers `/api/health`, it aborts rather than removing `node\` under a running server.
2. Replaces `node\` with the bundled Node.
3. Asks for the **projects folder** (a directory page). The default is the existing user `PROJECTS_ROOT`, else an inherited `PROJECTS_ROOT`, else `%USERPROFILE%\code-conductor`. Silent installs take `/PROJECTS=<dir>`, which wins over all of those: `/S /PROJECTS="D:\My projects"`.
4. Runs `setup.mjs` with that Node. Progress goes to the details pane and `logs\setup.log`:
   - **Projects folder (validated first, before any download):** it must be an absolute path (drive letter or UNC) that is not the install directory or inside it (uninstall deletes that), and not an existing file.
   - **Git for Windows:** uses an existing Git that has Git Bash (`git.exe` in `<root>\cmd` or `<root>\bin`, plus `<root>\bin\bash.exe`), found on PATH, in `%LOCALAPPDATA%\Programs\Git` or in `%ProgramFiles%\Git`. A `git.exe` in `usr\bin`, `mingw64\bin` or `mingw32\bin` (Git's "optional Unix tools" PATH option) does not count. Setup uses the install's own `cmd\git.exe` (else `bin\git.exe`). Otherwise it downloads the pinned Git installer, checks its sha256 and installs it per-user (`/CURRENTUSER`, Git's `cmd` on PATH).
   - **Claude Code:** uses `claude.exe` on PATH (an npm `.cmd` shim does not count) or `%USERPROFILE%\.local\bin\claude.exe`. Otherwise it runs the official installer (`irm https://claude.ai/install.ps1 | iex`).
   - **User PATH:** appends `%USERPROFILE%\.local\bin` to the user `Path` (`HKCU\Environment`) if it is absent, keeping the existing entries, any `%VAR%` in them, non-ASCII characters and the value's kind (a new value is `REG_EXPAND_SZ`). It reads and writes through PowerShell's .NET registry API, not `reg.exe`, whose output is in the console code page. A Path it cannot read, or of a kind other than `REG_SZ`/`REG_EXPAND_SZ`, aborts setup rather than being overwritten.
   - **Checkout:** a fresh install clones cc's latest `main` from GitHub into `app\` (LF line endings, `core.autocrlf=false`, branch with upstream, `origin` = the source). An existing checkout is fetched and compared with the latest `main`, and never reset, since it may hold self-updated or local commits. The clone or fetch is tried 3 times (2 s, then 4 s apart) with Git's credential prompts off, so a bad URL fails instead of hanging; a final failure aborts the install and points at `setup.log`.

     | Existing `HEAD` | Result |
     |---|---|
     | equal to the latest `main` | kept |
     | behind | fast-forwarded; kept if local changes block it (self-update handles it later) |
     | ahead | kept |
     | diverged (neither contains the other) | **setup fails**, naming both commits |

     Setup checks the **installer contract** (see `src/contract.mjs`) with `git show` against the fetched tip and against the final `HEAD`:
     - `bin\windows-launch.mjs`, `package.json`, `package-lock.json` and `LICENSE` exist;
     - `package.json` parses and has a string `version`;
     - no `package-lock.json` `packages` entry has `hasInstallScript` (`npm ci` gets no build toolchain);
     - `engines.node` is `>=N[.N[.N]]` and the bundled Node satisfies it.

     | Failing revision | Result |
     |---|---|
     | fresh install, latest `main` fails | **setup fails**, naming the problems; the partial `app\` is removed so a re-run starts clean |
     | existing install, latest `main` fails | not applied; `HEAD` is kept with a warning in `setup.log`, and the install continues if `HEAD` passes |
     | the `HEAD` that results fails (any path) | **setup fails**, naming the problems |

     A fresh install has nothing usable to fall back on. An existing one keeps working, and refusing it would also block a re-run to repair Node, Git or Claude Code. A failing checkout keeps its git config: `origin` and `core.autocrlf` are set only after these checks pass. To recover from a failed checkout, uninstall, then run the installer again; your projects folder is kept. The installed commit is logged: `checkout: installed cc <version> at <sha> (<branch> from <source>)`.
   - **Dependencies:** `npm ci` in `app\` with the bundled Node and npm.
   - **Projects:** creates the folder and saves it as the user environment variable `PROJECTS_ROOT` (`HKCU\Environment`, which cc's launcher honours), through the same PowerShell channel as the Path. It writes only when the folder differs from what the launcher would already use (the user value, else an inherited one, else the default), so a default install leaves the registry alone and an existing `%VAR%` form is kept. A value of a kind other than `REG_SZ`/`REG_EXPAND_SZ` aborts setup rather than being overwritten.
5. Only if setup succeeded: writes `code-conductor.exe` (the Start-menu stub), `uninstall.exe`, the Start-menu shortcut and the Apps & features entry (`DisplayVersion` = the installer's version), sets `PROJECTS_ROOT` in the installer's own environment so the finish page's Launch uses the chosen folder, and shows the finish page. A failed setup aborts the installer (exit code 2 when silent) and points at `logs\setup.log`.

The finish page offers to launch cc. Sign in to Claude once with `claude auth login` in a terminal if you haven't already. Your projects live in the folder you chose.

### Install layout

```
%LOCALAPPDATA%\Programs\code-conductor\
  code-conductor.exe   Start-menu stub: runs node\node.exe app\bin\windows-launch.mjs
  uninstall.exe
  node\                bundled Node + npm (the pinned version)
  app\                 the cc git checkout (origin = the installer's source, GitHub; branch main)
  logs\                setup.log (installer), server.log / server.prev.log (launcher)
```

### Launcher

`code-conductor.exe` is a windowless stub that runs cc's own launcher, `app\bin\windows-launch.mjs`, with the bundled Node. The launcher ships in the cc checkout and updates with it. It reuses a running cc, or starts the server and opens the UI; on failure the stub shows its message in a message box. The launcher's modes, server environment and logs are documented in [cc docs/windows.md](https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#launcher).

### Update

- **cc:** the in-app self-update runs `git pull --ff-only` + `npm install` in `app\` and restarts.
- **Re-running the installer** stops cc, replaces `node\`, and brings `app\` forward to the latest `main` under the Checkout rules above. A checkout ahead of `main` is kept; a diverged one fails the install.

### Node is never updated by self-update

In-app self-update moves only `app\`. The bundled `node\` stays at the version this installer pinned until a newer installer release is run; every install replaces `node\`. When a cc update raises its `engines.node` past the bundled Node, cc warns at boot. Run the newest installer to fix it.

### Uninstall

Apps & features → code-conductor, or `uninstall.exe` (`/S` for silent). It stops a running cc, then removes the install directory, the Start-menu shortcut and the Apps & features entry. It **keeps** your projects folder (and its `.code-conductor` store), the user `PROJECTS_ROOT` variable naming it (so a re-install finds the same projects), Git for Windows, Claude Code and the user PATH entry.

### Limitations

- The exe is unsigned, so SmartScreen warns on first run ("More info" → "Run anyway").
- Downloads (Git, Claude Code's installer) use Node's `fetch`, which ignores the system proxy; the cc clone/fetch uses Git's own proxy settings.
- Installing needs network access to GitHub and the npm registry.
- A projects folder chosen on a re-install does not move existing projects.
- Signing in to Claude is manual: `claude auth login`.

## Technical

### Stack and layout

Node 24 ESM scripts, no npm dependencies; NSIS (`makensis`) compiles the installer on Linux.

```
src/
  build.mjs       builds the exe: stage this repo's files + Node, makensis
  setup.mjs       install-time CLI the installer runs with the bundled Node
  contract.mjs    the installer-contract checks on a cc revision (used by setup.mjs)
  projects.mjs    projects-folder validation and the user PROJECTS_ROOT write (used by setup.mjs)
  toolchain.mjs   Git/claude detection and the user-environment channel (used by setup.mjs)
  icon.ico        the installer, uninstaller, stub and shortcut icon
  pins.json       pinned Node zip and Git for Windows installer (version, url, sha256)
  installer.nsi   installer + uninstaller
  launcher.nsi    Start-menu stub (code-conductor.exe)
tests/            node:test suites; zip.mjs is a minimal zip writer for fixtures
build/            output exes; build/cache/ holds downloaded pins (gitignored)
```

`setup.mjs` runs before any cc checkout exists (it needs Git to clone), so it cannot import cc. `toolchain.mjs` therefore carries copies of the launcher's env/PATH helpers and claude detection. Its `detectGit` accepts only Git layouts cc's `resolveGitBash` also finds, which is contract clause C8.

### Build

Needs Node ≥ 24, `unzip` and NSIS (`sudo apt install nsis`).

```
npm run build
npm run build -- --source <url or path of a cc repo> --branch my-branch   # a test build
MAKENSIS=/path/to/makensis npm run build
```

| Flag / env | Default | Meaning |
|---|---|---|
| `--source` | `https://github.com/UnmanagedCode/code-conductor.git` | Where the installer clones cc from at install time; baked in as the `SOURCE` define and the installed checkout's `origin` |
| `--branch` | `main` | Branch the installer clones and self-update follows; baked in as `BRANCH` |
| `MAKENSIS` | `makensis` | NSIS compiler |

Neither flag may be empty or contain whitespace or a double quote (they reach the `makensis` command line).

Output: `build/code-conductor-setup-<package.json version>.exe`. Reproducible in its inputs (pinned Node, this repo's sources), not byte-identical. cc is not fetched at build time, so one exe serves every cc commit.

`src/build.mjs` (`buildInstaller`):

1. Checks `makensis` and `unzip` are present, and validates `--source`/`--branch`.
2. Stages the repo-root `LICENSE`, this repo's shipped `src/` files (`SHIPPED` in `build.mjs`) and the pinned Node (from `build/cache/` when its sha256 matches, else downloaded and checked).
3. Runs `makensis` on `launcher.nsi`, then `installer.nsi`. The installer's defines are `VERSION`, `SOURCE`, `BRANCH`, `STAGE`, `OUTFILE`, `LAUNCHER` (`bin\windows-launch.mjs`) and `ICON`; the stub gets `OUTFILE`, `LAUNCHER` and `ICON`.

### Icon

`src/icon.ico` is cc's `public/icon.svg` (white chevron and "CC" on black) rendered once and committed, so the build needs no image tool. Regenerate it only when cc's icon changes, with ImageMagick and the DejaVu Sans Mono font (the SVG's `ui-monospace`/Menlo stack is not installed on Linux, and ImageMagick's own SVG renderer draws strokes only with an explicit `stroke-opacity`):

```
sed -e 's/font-family="[^"]*"/font-family="DejaVu Sans Mono"/' -e 's/stroke="#fff"/stroke="#fff" stroke-opacity="1"/' <cc>/public/icon.svg > /tmp/cc-icon.svg
convert -background none /tmp/cc-icon.svg -define icon:auto-resize=256,64,48,32,24,16 src/icon.ico
```

The installer and uninstaller use it through `MUI_ICON`/`MUI_UNICON`, the stub through `Icon`, and the Start-menu shortcut names the stub as its icon.

### Pins

`src/pins.json` holds `node` (the Windows x64 zip, bundled at build time) and `git` (the Git for Windows 64-bit installer, downloaded at install time only when Git is missing). Each pin has a `version`, a `url` and a `sha256`. To bump one:

- **Node:** take the `node-v<version>-win-x64.zip` line from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`. It must still satisfy cc's `engines.node`; setup refuses a cc whose `engines.node` it does not satisfy (the gated `tests/checkout.real.test.mjs` shows whether current cc `main` does).
- **Git:** take the `Git-<version>-64-bit.exe` asset's sha256 digest from the `git-for-windows/git` GitHub release.

### Tests

```
npm test                                        # node --test, no network, no deps
RUN_WIN_INSTALLER_BUILD=1 node --test tests/build.real.test.mjs
RUN_REAL_CC_FETCH=1 node --test tests/checkout.real.test.mjs   # network
PWSH=<path to pwsh> node --test tests/userpath.pwsh.test.mjs
```

On a Windows host, run the PowerShell suite with `PWSH=powershell.exe`. Windows PowerShell 5.1 is what `setup.mjs` runs, so that variant is the one that counts there; pwsh 7 on Linux only proves the scripts and the encoding path.

```
$env:PWSH = 'powershell.exe'; node --test tests/userpath.pwsh.test.mjs   # in a PowerShell prompt
```

| File | Covers |
|---|---|
| `tests/contract.test.mjs` | `contractProblems` over an in-memory revision: each missing file, unparseable JSON, install-script packages, `engines.node` forms, the contract URL in every message; `satisfiesEngines` |
| `tests/projects.test.mjs` | `checkProjectsRoot` (relative, inside the install dir, file, UNC, trailing `\`) and `persistProjectsRoot` against a fake of the PowerShell channel (unchanged → no write, kind kept, Binary refused, non-ASCII) |
| `tests/build.test.mjs` | `buildInstaller` with a fake `makensis`: version-named exe, the defines (no commit), the stage contents (no `cc.bundle`), `--source`/`--branch`, refused quote/whitespace, the pinned-zip cache, `icon.ico` structure |
| `tests/build.real.test.mjs` | Gated by `RUN_WIN_INSTALLER_BUILD=1`: the pinned Node download and real `makensis` produce a PE exe over 20 MB named by version only |
| `tests/checkout.test.mjs` | `checkout()` with real git against a local origin: fresh clone (LF, upstream, origin, installed line); equal/behind/ahead/diverged; a dirty tree kept; contract failures (fresh removes `app\`, existing keeps `HEAD` and warns, a failing `HEAD` fails with config untouched); 3 attempts on an unreachable source; prompts disabled for clone/fetch |
| `tests/checkout.real.test.mjs` | Gated by `RUN_REAL_CC_FETCH=1`: a real `checkout()` of GitHub `main` with the pinned Node, proving current cc `main` passes the install-time contract |
| `tests/setup.test.mjs` | `ensureGit` sha refusal, `downloadWithRetry` |
| `tests/toolchain.test.mjs` | `detectGit` layouts (mirroring cc's C8, plus the rejected `usr\bin`/`mingw64\bin`), `detectClaude`, `findOnPath`, `addToUserPath`/`readUserEnv`/`writeUserEnv` against a fake of the PowerShell channel (base64 JSON both ways, addressed by value name, exit 1 with localized stderr, non-ASCII round-trip) |
| `tests/userpath.pwsh.test.mjs` | Gated by `PWSH`: the real user-environment scripts run by real PowerShell through `runPowerShell`, with `HKCU\Environment` swapped for a fake key, so the encoding path is exercised end to end (non-ASCII round-trip for Path and PROJECTS_ROOT, a multi-KB Path past the command-line limit, kinds, failure exit codes) |
