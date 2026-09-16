#!/usr/bin/env node
/**
 * The v19 front end's type-check gate (#624).
 *
 * `svelte-check` reads the SvelteKit front end in web/, which the root
 * `pnpm typecheck` cannot see: tsconfig.json sets "allowJs": false and
 * includes only **\/*.ts and **\/*.tsx, while web/src holds no TypeScript at
 * all. From #620 until #624 this ran against a per-file error ledger
 * (`web/svelte-check-ceiling.json`, kept only as an empty historical record
 * now) while the v19 rebuild worked file by file down to zero. That rebuild
 * is done, so this is now a plain gate: any `svelte-check` error, in any
 * file, fails the fast checks. No per-file tolerance is left anywhere.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Counts ERROR lines per file from `svelte-check --output machine`. */
export function parseMachineOutput(output) {
  const counts = new Map();
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    const match = /^\d+\s+ERROR\s+"([^"]+)"/u.exec(line);
    if (!match) continue;
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

const plural = (count) => `${count} error${count === 1 ? "" : "s"}`;

/** Turns per-file counts into the total and the report lines for a failure. */
export function summarize(counts) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const lines = [...counts.entries()].map(([file, count]) => `${file}: ${plural(count)}`);
  return { total, lines };
}

function runSvelteCheck() {
  try {
    return execFileSync(
      "node_modules/.bin/svelte-check",
      ["--tsconfig", "./tsconfig.json", "--output", "machine"],
      { cwd: `${repositoryRoot}web`, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (error) {
    // svelte-check exits non-zero whenever it found anything, which is the
    // normal case here -- its stdout is still the report we want. Only a
    // failure to produce one at all is fatal.
    if (typeof error?.stdout === "string" && error.stdout.includes("COMPLETED")) return error.stdout;
    throw error;
  }
}

/**
 * Whether `orbit/server/*` resolves to THIS checkout (#1029).
 *
 * `web/node_modules` is a workspace link, and in a worktree it usually points
 * at the main checkout: `web/node_modules/orbit -> /home/codex/projects/orbit`.
 * The `.svelte` and `.js` files being checked are then read from the worktree
 * while the server modules they import are read from whatever branch the main
 * checkout happens to have out. The answer belongs to neither branch.
 *
 * Both failure modes are bad and the second is worse. A false error — the
 * other branch lacks a module this one added — is merely costly, and invites
 * "fixing" an import that was already right. A false pass — the other branch
 * still has a module this one deleted or renamed — lets a genuinely broken
 * import go green locally and fail in CI.
 *
 * Returns the path it resolved to when that is somewhere else, or null when
 * the resolution is sound.
 */
export function foreignWorkspaceRoot(repositoryRoot) {
  try {
    const linked = realpathSync(`${repositoryRoot}web/node_modules/orbit`);
    const here = realpathSync(repositoryRoot).replace(/\/$/u, "");
    return linked === here ? null : linked;
  } catch {
    // No link at all: nothing resolves outside this tree, so nothing to warn
    // about. A missing dependency is svelte-check's own error to report.
    return null;
  }
}

function main() {
  /* CI checks out one self-contained tree, so this never fires there; it is
     the local check, run before the expensive suites, that this protects. */
  const foreign = foreignWorkspaceRoot(repositoryRoot);
  if (foreign) {
    console.error("\nv19 type check: SKIPPED -- it cannot answer for this checkout.\n");
    console.error(`  web/node_modules/orbit resolves to ${foreign}`);
    console.error(`  which is not ${realpathSync(repositoryRoot).replace(/\/$/u, "")}\n`);
    console.error("  So `orbit/server/*` would be read from whatever branch THAT directory has");
    console.error("  checked out, and the result would belong to neither branch -- a wrong answer,");
    console.error("  in either direction, and a passing one is the dangerous half (#1029).\n");
    console.error("  Run this check in the main checkout, or give this worktree its own");
    console.error("  node_modules, or let CI answer it -- CI checks out one tree and is unaffected.\n");
    /* Deliberately not an error. Thirty worktrees share this host, so failing
       here would abort the fast gate in most of them -- the #1024 mistake of
       making a known, understood condition fatal. "Cannot check here" is the
       honest answer; a wrong one is what this exists to prevent. */
    return;
  }

  const counts = parseMachineOutput(runSvelteCheck());
  const { total, lines } = summarize(counts);

  if (total === 0) {
    console.log("v19 type check: 0 errors across web/.");
    return;
  }

  console.error(`\nv19 type check: ${plural(total)} across ${counts.size} file${counts.size === 1 ? "" : "s"}:\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error("\nweb/ type-checks at zero (#624) -- no per-file tolerance is left. Fix these, don't ledger them.");
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
