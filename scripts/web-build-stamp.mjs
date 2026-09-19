#!/usr/bin/env node
/**
 * Is the web application in `web/build` the one this checkout describes? (#1061)
 *
 * The web app used to be built three times in one pipeline: once by
 * `scripts/test-backend.sh`, again by the `fast` job, and a third time by
 * every Playwright `webServer` that stood the app up. Building once and
 * sharing the result needs an answer to "is a usable build already here?"
 * that is safe to trust, because the alternative failure -- serving a stale
 * build and calling it a pass -- is worse than the wasted minutes.
 *
 *   node scripts/web-build-stamp.mjs write   after a build, records the inputs
 *   node scripts/web-build-stamp.mjs check   exit 0 when the build matches them
 *
 * The answer is a content hash, not a timestamp. Timestamps cannot work here:
 * a CI job clones the repository (new mtimes on every source file) and only
 * then downloads the build artefact (whose mtimes come from the earlier job),
 * so the build always looks older than its own sources. Content survives both
 * the clone and the artefact round trip.
 *
 * What counts as an input is what `vite build` actually consumes: the whole of
 * `web/` less its own test suite, the `orbit` workspace package in `src/` that
 * `web/src` imports through `orbit/server/*`, and the manifests that pin the
 * dependency versions the bundle is built from. Generated and ignored paths --
 * `web/build`, `web/.svelte-kit`, `web/static/licenses` -- are excluded by
 * asking git, which already knows what is ignored; otherwise the build's own
 * output would change the hash the moment it was written and no build would
 * ever look current.
 *
 * Erring wide is deliberate, in the same way `scripts/ci/job-inputs.json` errs
 * wide: an input listed that the build does not really read costs one rebuild,
 * and an input missed serves a stale application.
 *
 * One consequence to expect locally: a local pnpm command writes an
 * `@pnpm/exe` block into pnpm-lock.yaml (the pnpm 11 -> 12.3.4 handoff, #901,
 * see AGENTS.md), and `git checkout -- pnpm-lock.yaml` takes it back out
 * again, so the lockfile's content usually differs between a build and the
 * next run. That is a real difference by the rule above, and the next run
 * rebuilds -- exactly what it did before this existed, so nothing is lost. CI
 * never sees it: corepack activates the pinned pnpm there and the install is
 * `--frozen-lockfile`, so the saving lands where the three builds were.
 *
 * Environment:
 *   ORBIT_WEB_STAMP_ROOT   the checkout to read inputs from (default: this
 *                          script's own repository; set by the tests, which
 *                          drive it against a throwaway git repository)
 *   ORBIT_WEB_BUILD_ROOT   the adapter-node output (default: <root>/web/build)
 *   ORBIT_FORCE_WEB_BUILD  set to any non-empty value to make `check` always
 *                          report "not current", forcing a rebuild
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = process.env.ORBIT_WEB_STAMP_ROOT
  ? resolve(process.env.ORBIT_WEB_STAMP_ROOT)
  : fileURLToPath(new URL("../", import.meta.url));
const buildRoot = process.env.ORBIT_WEB_BUILD_ROOT
  ? resolve(process.env.ORBIT_WEB_BUILD_ROOT)
  : join(repositoryRoot, "web", "build");
const stampPath = join(buildRoot, ".orbit-build-inputs");

/**
 * The pathspecs handed to `git ls-files`. `:(exclude)` is git's own syntax, so
 * the exclusion is applied by git rather than re-implemented here.
 */
export const inputPathspecs = [
  "web",
  "src",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  // The fidelity baselines and the e2e specs live here. Nothing under it
  // reaches the bundle, and baseline churn is the commonest change in the
  // repository, so including it would rebuild for no reason every time.
  ":(exclude)web/tests",
];

/** Every input path git knows about: tracked, plus untracked-but-not-ignored. */
export function inputPaths(root = repositoryRoot) {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...inputPathspecs],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(listing.split("\0").filter(Boolean))].sort();
}

/**
 * A hash over those paths and their working-tree contents.
 *
 * The working tree, not the index: an unstaged edit to a component is exactly
 * the case a developer needs a rebuild for. A path git lists but that is not
 * on disk -- a tracked file deleted without being staged -- hashes as absent
 * rather than throwing, which is itself a change and so still forces a build.
 */
export function inputHash(paths, root = repositoryRoot) {
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    try {
      digest.update(createHash("sha256").update(readFileSync(join(root, path))).digest());
    } catch {
      digest.update("absent");
    }
    digest.update("\n");
  }
  return digest.digest("hex");
}

/** The build output itself, independent of the stamp. */
function builtOutputPresent() {
  return existsSync(join(buildRoot, "index.js")) && existsSync(join(buildRoot, "server"));
}

function currentHash() {
  return inputHash(inputPaths());
}

function write() {
  if (!builtOutputPresent()) {
    // Nothing to vouch for. Not an error: the caller may be a build that
    // failed, and a stamp for a build that is not there would be a lie.
    process.stderr.write("web build stamp: no adapter-node output to stamp\n");
    return 0;
  }
  let hash;
  try {
    hash = currentHash();
  } catch (error) {
    // The container image build is the case this is written for: `.dockerignore`
    // keeps `.git` out of the context, so there is no repository to ask. The
    // image builds from source every time and never reads this stamp, so the
    // right answer is to leave none rather than to fail the build.
    process.stderr.write(`web build stamp: not recorded (${error.message.split("\n")[0]})\n`);
    return 0;
  }
  writeFileSync(stampPath, `${JSON.stringify({ inputs: hash, builtAt: new Date().toISOString() }, null, 2)}\n`);
  process.stdout.write(`web build stamp: recorded inputs ${hash.slice(0, 12)}\n`);
  return 0;
}

function check() {
  if (process.env.ORBIT_FORCE_WEB_BUILD) {
    process.stdout.write("web build: ORBIT_FORCE_WEB_BUILD is set, so a rebuild is wanted\n");
    return 1;
  }
  if (!builtOutputPresent()) {
    process.stdout.write("web build: none in web/build, so it must be built\n");
    return 1;
  }
  if (!existsSync(stampPath)) {
    process.stdout.write("web build: present but unstamped, so it cannot be vouched for; rebuilding\n");
    return 1;
  }
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(stampPath, "utf8")).inputs;
  } catch {
    process.stdout.write("web build: its stamp is unreadable; rebuilding\n");
    return 1;
  }
  let hash;
  try {
    hash = currentHash();
  } catch (error) {
    process.stdout.write(`web build: cannot read this checkout's inputs (${error.message.split("\n")[0]}); rebuilding\n`);
    return 1;
  }
  if (hash !== recorded) {
    process.stdout.write("web build: built from different sources than this checkout has; rebuilding\n");
    return 1;
  }
  process.stdout.write(`web build: current for inputs ${hash.slice(0, 12)}, so it is not built again\n`);
  return 0;
}

// Only when run as a command. The functions above are exported so
// scripts/web-build-stamp.test.mjs can exercise the hash directly, and an
// import must not exit the importer's process.
const runAsCommand = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (runAsCommand) {
  const command = process.argv[2];
  if (command === "write") process.exit(write());
  else if (command === "check") process.exit(check());
  else {
    process.stderr.write("usage: web-build-stamp.mjs <write|check>\n");
    process.exit(2);
  }
}
