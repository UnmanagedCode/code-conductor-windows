// The installer contract's checks on a cc revision, run by setup.mjs at
// install time against git objects. What a cc revision must provide:
// CONTRACT_URL.
export const CONTRACT_URL = 'https://github.com/UnmanagedCode/code-conductor/blob/main/docs/windows.md#installer-contract';
// The launcher inside the checkout (contract C4); the stub and the
// installer's StopRunning get it as the LAUNCHER define.
export const LAUNCHER_REL = 'bin/windows-launch.mjs';
const ENGINES_RE = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

const versionParts = (v) => v.split('.').map(Number);

// Whether `version` (N.N.N) satisfies `range` (>=N[.N[.N]]); null when the
// range is not of that form.
export function satisfiesEngines(version, range) {
  const m = ENGINES_RE.exec(range);
  if (!m) return null;
  const want = [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number);
  const have = versionParts(version);
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  }
  return true;
}

// `read(rel)` resolves a file's text from the revision, or null when it is
// absent. Returns {problems, version}: every failed check, none when the
// revision can be installed with `nodeVersion`.
export async function contractProblems(read, nodeVersion) {
  const problems = [];
  const files = {};
  for (const f of [LAUNCHER_REL, 'package.json', 'package-lock.json', 'LICENSE']) {
    files[f] = await read(f);
    if (files[f] === null) problems.push(`${f} is missing`);
  }
  let pkg = {};
  if (files['package.json'] !== null) {
    try { pkg = JSON.parse(files['package.json']); } catch (e) { problems.push(`package.json does not parse: ${e.message}`); }
  }
  if (typeof pkg.version !== 'string') problems.push('package.json has no string "version"');
  // `npm ci` on the user's machine has only the bundled node + npm, no build toolchain.
  if (files['package-lock.json'] !== null) {
    try {
      const scripted = Object.entries(JSON.parse(files['package-lock.json']).packages ?? {}).filter(([, p]) => p.hasInstallScript).map(([k]) => k);
      if (scripted.length) problems.push(`package-lock.json has packages with install scripts: ${scripted.join(', ')}`);
    } catch (e) { problems.push(`package-lock.json does not parse: ${e.message}`); }
  }
  const range = pkg.engines?.node;
  const ok = typeof range === 'string' ? satisfiesEngines(nodeVersion, range) : null;
  if (ok === null) problems.push(`package.json engines.node ${JSON.stringify(range)} is not of the form >=N[.N[.N]]`);
  else if (!ok) problems.push(`the bundled Node ${nodeVersion} does not satisfy engines.node "${range}"`);
  return { problems, version: pkg.version };
}

// The failed checks as a message tail for the caller to embed.
export const contractError = (problems) => `\n  - ${problems.join('\n  - ')}\n(${CONTRACT_URL})`;
