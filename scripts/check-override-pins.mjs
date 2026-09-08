// Keep pnpm override keys pointed at packages that are actually there (#881).
//
// An override key can name the version it applies through:
//
//     'postcss@8.5.23>nanoid': 3.3.18
//
// which means "nanoid, but only when reached via postcss 8.5.23". That is a
// fine thing to write and a dangerous thing to leave alone. The moment postcss
// moves -- a patch bump, a Renovate merge request nobody reads twice -- the key
// matches nothing. pnpm does not warn: an override that selects no package is
// not an error to pnpm, it is simply an override with no work to do. The
// comment above it goes on claiming a security floor that stopped applying.
//
// That is the exact shape of the near miss on #881: !869 bumped postcss
// 8.5.23 -> 8.5.28 throughout the lockfile and left the key behind, which would
// have disarmed a CVE mitigation while still reading as enforced.
//
// So this check reads every version-scoped selector out of the overrides in
// pnpm-workspace.yaml and asserts the lockfile still contains that exact
// name@version. It deliberately does not look at the lockfile's own `overrides:`
// block, which is a copy of the workspace file and would agree with it even when
// both are wrong.
//
// --red proves the check can fail, in the manner of sidecar-pins.mjs and
// test-install-bootstrap.sh: a check nobody has ever seen fail is a check
// nobody should trust.

import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_PATH = join(REPO_DIR, "pnpm-workspace.yaml");
const LOCKFILE_PATH = join(REPO_DIR, "pnpm-lock.yaml");

// A scoped selector is `name@version`, where the name may itself be scoped
// (`@scope/pkg@1.2.3`), so the split is on the LAST `@`.
const SELECTOR = /(?<name>@?[^@>\s'"]+(?:\/[^@>\s'"]+)?)@(?<version>[^@>\s'"]+)/gu;

/** The `overrides:` mapping of pnpm-workspace.yaml, as raw `key: value` pairs. */
export function readOverrideKeys(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === "overrides:");
  if (start === -1) return [];
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // A new top-level block ends the overrides mapping.
    if (!line.startsWith("  ")) break;
    const match = /^ {2}(?<key>'[^']+'|"[^"]+"|[^:]+):/u.exec(line);
    if (!match) continue;
    keys.push(match.groups.key.replace(/^['"]|['"]$/gu, ""));
  }
  return keys;
}

/**
 * Every `name@version` the lockfile actually resolved, taken from the
 * `packages:` block alone. `snapshots:` repeats them and `overrides:` is a copy
 * of the file being checked, so neither is evidence.
 */
export function readLockedPackages(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("packages:");
  if (start === -1) {
    throw new Error("pnpm-lock.yaml has no packages: block to read.");
  }
  const locked = new Set();
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith("  ")) break;
    const match = /^ {2}(?<id>@?[^\s:]+):$/u.exec(line);
    if (match) locked.add(match.groups.id);
  }
  return locked;
}

/** Version-scoped selectors inside one override key. */
export function selectorsIn(key) {
  return [...key.matchAll(SELECTOR)].map((match) => ({
    name: match.groups.name,
    version: match.groups.version,
    id: `${match.groups.name}@${match.groups.version}`,
  }));
}

/** The package an override key ultimately selects: the part after the last `>`. */
export function targetOf(key) {
  const target = key.slice(key.lastIndexOf(">") + 1);
  const at = target.lastIndexOf("@");
  return at > 0 ? target.slice(0, at) : target;
}

export function findStaleSelectors(keys, locked, lockedNames) {
  const stale = [];
  for (const key of keys) {
    for (const selector of selectorsIn(key)) {
      if (!locked.has(selector.id)) stale.push({ key, ...selector });
    }
    // A key with no version in it can still stop matching: if the package
    // leaves the tree entirely, the override sits there selecting nothing, and
    // the comment above it goes on describing a floor. Found while triaging
    // !871 (#882), which removes eslint's last dependency on js-yaml and would
    // strand the `js-yaml:` override that way.
    const target = targetOf(key);
    if (!lockedNames.has(target)) {
      stale.push({ key, name: target, version: null, id: target });
    }
  }
  return stale;
}

function report(stale, write) {
  for (const entry of stale) {
    write(`override pins: '${entry.key}' selects ${entry.id}, which the lockfile does not contain.\n`);
    write(`  The override therefore applies to nothing, silently. Anything the\n`);
    write(`  comment above it promises is not in force.\n`);
    if (entry.version === null) {
      write(`  ${entry.name} is not in the tree at all any more. Delete the override\n`);
      write(`  and the comment above it, rather than leaving a floor for a package\n`);
      write(`  nothing depends on.\n`);
    } else {
      write(`  Fix: drop the '@${entry.version}' from the key so it matches whatever\n`);
      write(`  version of ${entry.name} is resolved, or re-scope it to the version now\n`);
      write(`  in the lockfile and say in the comment why it is pinned that way.\n`);
    }
  }
}

export function main(argv = process.argv.slice(2), write = process.stdout.write.bind(process.stdout)) {
  const red = argv.includes("--red");
  const workspace = readFileSync(WORKSPACE_PATH, "utf8");
  const locked = readLockedPackages(readFileSync(LOCKFILE_PATH, "utf8"));
  let keys = readOverrideKeys(workspace);

  if (red) {
    // Not a random string: this is the real key as it stood before #881, and
    // the version it named is one postcss patch release behind the tree. If the
    // check cannot catch this, it would not have caught the thing it exists for.
    keys = ["postcss@0.0.0-not-in-tree>nanoid"];
  }

  const lockedNames = new Set(
    [...locked].map((id) => {
      const at = id.lastIndexOf("@");
      return at > 0 ? id.slice(0, at) : id;
    }),
  );
  const stale = findStaleSelectors(keys, locked, lockedNames);

  if (red) {
    if (stale.length === 0) {
      write("override pins: --red found nothing stale. The check is not working.\n");
      return 1;
    }
    write("override pins: --red caught the planted stale key, as it should.\n");
    report(stale, write);
    return 0;
  }

  if (stale.length > 0) {
    report(stale, write);
    write(`override pins: ${stale.length} override key(s) select nothing.\n`);
    return 1;
  }

  write(`override pins: all ${keys.length} override key(s) select packages the lockfile contains.\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
