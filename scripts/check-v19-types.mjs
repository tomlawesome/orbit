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

function main() {
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
