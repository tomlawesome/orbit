#!/usr/bin/env node
/**
 * The v19 type-check ledger (#620).
 *
 * `svelte-check` reads the SvelteKit front end in web/, which the root
 * `pnpm typecheck` cannot see: tsconfig.json sets "allowJs": false and includes
 * only **\/*.ts and **\/*.tsx, while web/src holds no TypeScript at all. It has
 * never run in CI, so 1,644 complaints accumulated -- overwhelmingly implicit
 * `any` and DOM narrowing rather than defects. Gating on zero would fail every
 * pull request on day one; leaving it off lets the pile grow unseen.
 *
 * So the ledger below records, per file, exactly how many errors are tolerated
 * today, and the count must match exactly. Owner decision, 2026-08-24:
 *
 *   - A file that gets worse fails. That is the point.
 *   - A file that gets BETTER also fails, asking for its number to be lowered.
 *     Exact match is what walks the ledger down to nothing instead of leaving
 *     slack nobody ever reclaims. svelte-check is deterministic against a
 *     frozen lockfile, so this cannot flap.
 *   - A file with no entry may have no errors, so anything newly written --
 *     every screen M2 rebuilds -- lands clean and stays clean.
 *   - Never add an entry, and never raise one. The only legitimate edits are
 *     lowering a number and deleting an entry that reached zero.
 *
 * When the ledger is empty the gate is a plain zero-error check and this file
 * can go. Until then M2 cannot close: see the ledger's own `issue` field.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ledgerPath = new URL("../web/svelte-check-ceiling.json", import.meta.url);

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

/**
 * Sorts every file into the one thing that is wrong with it, if anything.
 * `improved` and `stale` are failures too: both mean the ledger no longer
 * describes reality, and a ledger nobody updates is a ledger nobody reads.
 */
export function compareToLedger(counts, files) {
  const worse = [];
  const unledgered = [];
  const improved = [];
  const stale = [];

  for (const [file, count] of counts) {
    const allowed = files[file];
    if (allowed === undefined) unledgered.push({ file, count });
    else if (count > allowed) worse.push({ file, count, allowed });
    else if (count < allowed) improved.push({ file, count, allowed });
  }
  for (const file of Object.keys(files)) {
    if (!counts.has(file)) stale.push(file);
  }
  return { worse, unledgered, improved, stale };
}

const plural = (count) => `${count} error${count === 1 ? "" : "s"}`;

export function describeResult({ worse, unledgered, improved, stale }) {
  const lines = [];
  for (const { file, count, allowed } of worse) {
    lines.push(`${file}: ${plural(count)}, ledger allows ${allowed}. Fix the new ones.`);
  }
  for (const { file, count } of unledgered) {
    lines.push(`${file}: ${plural(count)} and no ledger entry. New and rewritten files must be clean -- do not add an entry.`);
  }
  for (const { file, count, allowed } of improved) {
    lines.push(`${file}: ${plural(count)}, ledger still says ${allowed}. Lower it to ${count}.`);
  }
  for (const file of stale) {
    lines.push(`${file}: no errors left, or the file is gone. Delete its ledger entry.`);
  }
  return lines;
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
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const counts = parseMachineOutput(runSvelteCheck());
  const result = compareToLedger(counts, ledger.files);
  const problems = describeResult(result);

  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const allowed = Object.values(ledger.files).reduce((sum, count) => sum + count, 0);
  console.log(`v19 type ledger: ${total} errors across ${counts.size} files; ledger allows ${allowed} across ${Object.keys(ledger.files).length}.`);

  if (problems.length === 0) {
    if (Object.keys(ledger.files).length === 0) {
      console.log("The ledger is empty: web/ now type-checks clean. Delete it and this script's ledger handling (#620).");
    }
    return;
  }

  console.error("\nThe v19 type ledger no longer matches reality:\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`\nThe ledger is ${fileURLToPath(ledgerPath).replace(repositoryRoot, "")}. Never add an entry and never raise one; lowering and deleting are the only edits that move this forward.`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
