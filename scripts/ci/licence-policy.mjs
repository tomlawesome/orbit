// Checks every package in the installed dependency tree against
// supply-chain/licence-policy.yml, the licence half of the dependency check
// GitHub's actions/dependency-review-action used to run. That action stopped
// running when GitHub became a push mirror with no pull requests (#801): it
// only ever compared a pull-request diff, and there are no pull requests to
// compare. This script replaces it with something the diff shape cannot do
// anyway -- it walks the whole installed tree, not the change, so a licence
// problem already sitting in the lockfile is caught too, not just a newly
// added one.
//
// Tree discovery reads package.json files directly off disk rather than
// shelling out to `pnpm licenses list --json`. That command was tried first
// (it does cover this repository's pnpm workspace, root and web/ alike) but
// two things ruled it out: the pure functions here need to run against a
// synthetic fixture tree in a test, with no real pnpm project or install
// behind it, and a direct read keeps this script in control of exactly which
// (name, version) pairs an `allow-dependencies-licenses` exception matches --
// pnpm's own grouping is by licence string, not by the exact-version identity
// the exceptions are pinned to.
//
// pnpm's default "isolated" node_modules layout is two kinds of directory:
//   node_modules/<name>/                          (a symlink into the store)
//   node_modules/.pnpm/<key>/node_modules/<name>/  (the real package)
// A dependency's own dependencies are symlinked the same way one level
// further in, so walking every node_modules directory recursively -- and
// de-duplicating by each package directory's real (post-symlink) path --
// reaches every installed package exactly once regardless of how deep pnpm
// nested it. web/ is a separate pnpm-workspace member with its own store
// (node_modules/.pnpm and web/node_modules/.pnpm are both real, distinct
// directories on this repository), so both are walked.
//
// SPDX licence expressions (`MIT OR Apache-2.0`, `A AND B`, parenthesised)
// are parsed and evaluated against the allow-list: OR passes if any branch is
// allowed, AND needs every part allowed. A missing, empty, `UNLICENSED`,
// `SEE LICENSE IN ...` or otherwise unparseable licence fails closed.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// --- policy file -------------------------------------------------------

function stripComment(line) {
  const hashIndex = line.indexOf("#");
  return hashIndex === -1 ? line : line.slice(0, hashIndex);
}

/**
 * Parses an exact-version dependency exception, `pkg:npm/<name>@<version>`.
 * <name> may itself contain "@" (a scoped package), so the version is
 * whatever follows the *last* "@".
 */
export function parsePurlException(purl) {
  const prefix = "pkg:npm/";
  if (!purl.startsWith(prefix)) {
    throw new Error(`unsupported dependency exception PURL: ${purl}`);
  }
  const rest = purl.slice(prefix.length);
  const lastAt = rest.lastIndexOf("@");
  if (lastAt <= 0) {
    throw new Error(`dependency exception PURL is missing a version: ${purl}`);
  }
  return { name: rest.slice(0, lastAt), version: rest.slice(lastAt + 1) };
}

/**
 * Loads the two-key licence policy file: `allow-licenses` (a flat list of
 * SPDX ids) and `allow-dependencies-licenses` (a flat list of exact-version
 * PURL exceptions). This is not a general YAML parser -- it understands only
 * this file's shape (two top-level keys, each an indented `- value` list,
 * `#` comments anywhere) -- because the repository has no YAML dependency to
 * reach for and this file does not need one.
 */
export function loadPolicy(policyPath) {
  const raw = readFileSync(policyPath, "utf8");
  const allowLicences = new Set();
  const allowExactExceptions = new Set();
  let currentKey = null;
  const lines = raw.split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;
    const topLevelMatch = /^([A-Za-z-]+):\s*$/u.exec(line);
    if (topLevelMatch) {
      currentKey = topLevelMatch[1];
      continue;
    }
    const itemMatch = /^\s+-\s+(\S+)\s*$/u.exec(line);
    if (itemMatch) {
      if (currentKey === "allow-licenses") {
        allowLicences.add(itemMatch[1]);
      } else if (currentKey === "allow-dependencies-licenses") {
        const { name, version } = parsePurlException(itemMatch[1]);
        allowExactExceptions.add(`${name}@${version}`);
      } else {
        throw new Error(`licence policy list item outside a known key: ${rawLine}`);
      }
      continue;
    }
    throw new Error(`unrecognised line in licence policy ${policyPath}: ${rawLine}`);
  }
  return { allowLicences, allowExactExceptions };
}

// --- SPDX expression parsing and evaluation -----------------------------

function tokenizeSpdxExpression(expression) {
  const tokens = [];
  let i = 0;
  while (i < expression.length) {
    const ch = expression[i];
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    let j = i;
    while (j < expression.length && !" \t()".includes(expression[j])) j += 1;
    tokens.push(expression.slice(i, j));
    i = j;
  }
  return tokens;
}

/** Parses an SPDX licence expression into a small AND/OR/id tree. */
export function parseSpdxExpression(expression) {
  const tokens = tokenizeSpdxExpression(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseAtom() {
    const token = peek();
    if (token === "(") {
      next();
      const node = parseOr();
      if (next() !== ")") throw new Error(`unbalanced parentheses: ${expression}`);
      return node;
    }
    if (token === undefined || token === "AND" || token === "OR" || token === ")") {
      throw new Error(`unexpected token in licence expression: ${expression}`);
    }
    next();
    if (peek() === "WITH") {
      next();
      const exceptionId = next();
      if (exceptionId === undefined) throw new Error(`dangling WITH: ${expression}`);
      // Folded into one atom: an exception-qualified licence must be listed
      // in allow-licences verbatim (with its exception) to be accepted.
      return { type: "id", id: `${token} WITH ${exceptionId}` };
    }
    return { type: "id", id: token };
  }

  function parseAnd() {
    let node = parseAtom();
    while (peek() === "AND") {
      next();
      node = { type: "and", left: node, right: parseAtom() };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (peek() === "OR") {
      next();
      node = { type: "or", left: node, right: parseAnd() };
    }
    return node;
  }

  if (tokens.length === 0) throw new Error("empty licence expression");
  const ast = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in licence expression: ${expression}`);
  return ast;
}

function evaluateSpdxAst(node, allowLicences) {
  if (node.type === "id") return allowLicences.has(node.id);
  if (node.type === "and") return evaluateSpdxAst(node.left, allowLicences) && evaluateSpdxAst(node.right, allowLicences);
  if (node.type === "or") return evaluateSpdxAst(node.left, allowLicences) || evaluateSpdxAst(node.right, allowLicences);
  return false;
}

const UNRECOGNISED_PREFIXES = ["SEE LICENSE IN"];

/**
 * True only for a non-empty, parseable SPDX expression every required branch
 * of which is in `allowLicences`. Anything else -- missing, empty,
 * `UNLICENSED`, `SEE LICENSE IN ...`, or a string that does not parse as an
 * SPDX expression -- fails closed rather than throwing.
 */
export function isLicenceAllowed(licenceExpression, allowLicences) {
  const trimmed = String(licenceExpression ?? "").trim();
  if (trimmed === "") return false;
  const upper = trimmed.toUpperCase();
  if (upper === "UNLICENSED") return false;
  if (UNRECOGNISED_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false;
  try {
    return evaluateSpdxAst(parseSpdxExpression(trimmed), allowLicences);
  } catch {
    return false;
  }
}

// --- installed-tree walk ------------------------------------------------

function licenceExpressionFromManifest(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object" && typeof manifest.license.type === "string") {
    return manifest.license.type;
  }
  // The legacy (pre npm 2.x) `licenses` array, still seen on very old
  // packages: dual entries are OR'd, matching how npm itself always treated
  // more than one entry in that array.
  if (Array.isArray(manifest.licenses)) {
    const parts = manifest.licenses
      .map((entry) => (entry && typeof entry.type === "string" ? entry.type : null))
      .filter((value) => value !== null);
    if (parts.length > 0) return parts.join(" OR ");
  }
  return "";
}

function readManifest(dir) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function recordPackageDir(dir, state) {
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (state.visited.has(realDir)) return;
  state.visited.add(realDir);
  if (state.skipRealPaths.has(realDir)) return;

  const manifest = readManifest(realDir);
  if (manifest && typeof manifest.name === "string" && typeof manifest.version === "string") {
    state.results.push({
      name: manifest.name,
      version: manifest.version,
      licence: licenceExpressionFromManifest(manifest),
    });
  }

  // A package that vendors its own nested node_modules (npm/yarn hoisting
  // artifacts, or a pnpm peer-conflict copy) gets walked the same way.
  const nested = join(realDir, "node_modules");
  if (existsSync(nested)) walkNodeModulesDir(nested, state);
}

function walkNodeModulesDir(nodeModulesDir, state) {
  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === ".bin") continue;
    const entryPath = join(nodeModulesDir, entry.name);

    if (entry.name === ".pnpm") {
      // The store: .pnpm/<key>/node_modules/<name-or-@scope/name>.
      let keys;
      try {
        keys = readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const key of keys) {
        if (!key.isDirectory() && !key.isSymbolicLink()) continue;
        walkNodeModulesDir(join(entryPath, key.name, "node_modules"), state);
      }
      continue;
    }

    if (entry.name.startsWith("@")) {
      let scopedEntries;
      try {
        scopedEntries = readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scoped of scopedEntries) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
        recordPackageDir(join(entryPath, scoped.name), state);
      }
      continue;
    }

    recordPackageDir(entryPath, state);
  }
}

function readWorkspaceMemberDirs(rootDir) {
  const workspaceFile = join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) return [];
  const members = [];
  let inPackages = false;
  for (const rawLine of readFileSync(workspaceFile, "utf8").split(/\r?\n/u)) {
    const line = stripComment(rawLine);
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const itemMatch = /^\s+-\s+"?([^"\s]+)"?\s*$/u.exec(line);
    if (itemMatch) {
      if (itemMatch[1] !== ".") members.push(itemMatch[1]);
      continue;
    }
    if (line.trim() === "") continue;
    inPackages = false;
  }
  return members;
}

/**
 * Walks every reachable `node_modules/**\/package.json` under `rootDir` --
 * its own `node_modules`, the `node_modules/.pnpm` store layout, and any
 * pnpm-workspace member's own `node_modules` (e.g. `web/`) -- and returns one
 * entry per distinct installed (name, version). The root package and every
 * workspace member's own package.json are excluded: Orbit is
 * AGPL-3.0-or-later and is not a dependency of itself.
 */
export function discoverInstalledPackages(rootDir) {
  const skipRealPaths = new Set();
  if (existsSync(join(rootDir, "package.json"))) skipRealPaths.add(realpathSync(rootDir));

  const nodeModulesRoots = [join(rootDir, "node_modules")];
  for (const member of readWorkspaceMemberDirs(rootDir)) {
    const memberDir = join(rootDir, member);
    if (existsSync(join(memberDir, "package.json"))) skipRealPaths.add(realpathSync(memberDir));
    nodeModulesRoots.push(join(memberDir, "node_modules"));
  }

  const state = { visited: new Set(), skipRealPaths, results: [] };
  for (const nodeModulesRoot of nodeModulesRoots) walkNodeModulesDir(nodeModulesRoot, state);
  return state.results;
}

// --- putting it together ------------------------------------------------

/**
 * Checks every installed package under `root` against the policy at
 * `policyPath`. Returns the total checked and the offending packages (empty
 * when everything is allowed).
 */
export function checkInstalledTree({ root, policyPath }) {
  const policy = loadPolicy(policyPath);
  const packages = discoverInstalledPackages(root);
  const offending = [];
  for (const pkg of packages) {
    if (policy.allowExactExceptions.has(`${pkg.name}@${pkg.version}`)) continue;
    if (!isLicenceAllowed(pkg.licence, policy.allowLicences)) offending.push(pkg);
  }
  return { checked: packages.length, offending };
}

// --- CLI -----------------------------------------------------------------

function parseCliArgs(argv) {
  let policy = "supply-chain/licence-policy.yml";
  let root = repositoryRoot;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--policy" && argv[i + 1] !== undefined) policy = argv[++i];
    else if (argv[i] === "--root" && argv[i + 1] !== undefined) root = argv[++i];
  }
  return {
    policy: isAbsolute(policy) ? policy : resolve(process.cwd(), policy),
    root: isAbsolute(root) ? root : resolve(process.cwd(), root),
  };
}

function main() {
  const { policy: policyPath, root } = parseCliArgs(process.argv.slice(2));
  let result;
  try {
    result = checkInstalledTree({ root, policyPath });
  } catch (error) {
    console.error(`licence policy check could not run: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
    return;
  }
  if (result.offending.length > 0) {
    for (const pkg of result.offending) {
      console.log(`${pkg.name}@${pkg.version}  ${pkg.licence || "(no licence)"}  → not allowed`);
    }
    console.log(`${result.offending.length} of ${result.checked} package(s) failed the licence policy.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${result.checked} package(s) checked against the licence policy; all allowed.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
