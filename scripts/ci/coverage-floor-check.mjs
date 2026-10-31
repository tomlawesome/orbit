#!/usr/bin/env node
// Per-directory coverage ratchet gate (#1099), after birdcage's
// scripts/coverage-floor.py. Reads Vitest's json-summary output and the floors
// in supply-chain/coverage-floors.mjs, and enforces two rules per directory and
// metric (statements, branches, functions, lines):
//
//   BELOW     coverage is under the floor: a regression.
//   HEADROOM  coverage is more than `headroom` points above the floor: raise
//             the floor. The upper rule exists because a gain that is not
//             locked in is a floor that rots: the next change can give the
//             gain back and still pass.
//
// A metric with something to measure but no recorded floor is reported as
// NO FLOOR <dir> <metric> rather than silently passing (#1536 D-F12).
//
// Setting ORBIT_COVERAGE_SKIP_HEADROOM=1 skips only the HEADROOM rule, for a
// local run whose summary includes the Docker suites (their coverage is higher
// than CI's). BELOW, NO FLOOR and NO FILES still apply. Any other value, empty
// or 0 included, keeps HEADROOM on. CI never sets it (#1536 D-F21).
//
// It also reports NO FLOOR (a top-level src/<dir> with no floor key) and
// NO FILES (a floor key matching no file). Every finding is printed; any
// finding exits 1, and any error (missing file, bad module) exits non-zero.
//
// Usage: node scripts/ci/coverage-floor-check.mjs [--summary <json>]
//   [--floors <module>] [--root <dir>]
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const METRICS = ["statements", "branches", "functions", "lines"];

function fmt(n) {
  return n.toFixed(2);
}

async function main() {
  const { values } = parseArgs({
    options: {
      summary: { type: "string", default: "coverage/coverage-summary.json" },
      floors: { type: "string", default: "supply-chain/coverage-floors.mjs" },
      root: { type: "string", default: process.cwd() },
    },
  });
  const root = resolve(values.root);
  const summary = JSON.parse(readFileSync(resolve(values.summary), "utf8"));
  const { floors, headroom } = await import(pathToFileURL(resolve(values.floors)).href);
  if (!floors || typeof floors !== "object" || typeof headroom !== "number") {
    throw new Error("floors module must export `floors` and numeric `headroom`");
  }

  const files = [];
  for (const [path, data] of Object.entries(summary)) {
    if (path === "total") continue;
    files.push({ rel: relative(root, path).split("\\").join("/"), data });
  }

  const skipHeadroom = process.env.ORBIT_COVERAGE_SKIP_HEADROOM === "1";
  const keys = Object.keys(floors);
  const findings = [];
  const rows = [];
  for (const key of keys) {
    const members = files.filter((f) => f.rel.startsWith(`${key}/`));
    if (members.length === 0) {
      findings.push(`NO FILES ${key}`);
      continue;
    }
    const row = [];
    for (const metric of METRICS) {
      let covered = 0;
      let total = 0;
      for (const f of members) {
        covered += f.data[metric]?.covered ?? 0;
        total += f.data[metric]?.total ?? 0;
      }
      if (total === 0) continue;
      const pct = Math.round((100 * covered) / total * 100) / 100;
      const floor = floors[key][metric];
      row.push(`${metric} ${fmt(pct)}`);
      if (typeof floor !== "number") {
        findings.push(`NO FLOOR ${key} ${metric} ${fmt(pct)}: no floor recorded for this metric`);
      } else if (pct < floor) {
        findings.push(`BELOW ${key} ${metric} ${fmt(pct)} < floor ${floor}`);
      } else if (!skipHeadroom && pct > floor + headroom) {
        findings.push(
          `HEADROOM ${key} ${metric} ${fmt(pct)} is more than ${headroom} points above floor ${floor}: raise the floor`,
        );
      }
    }
    rows.push(`${key}: ${row.join(", ")}`);
  }

  const topDirs = new Set();
  for (const f of files) {
    const m = /^src\/([^/]+)\//.exec(f.rel);
    if (m) topDirs.add(`src/${m[1]}`);
  }
  for (const dir of [...topDirs].sort()) {
    if (!keys.includes(dir)) findings.push(`NO FLOOR ${dir}`);
  }

  if (findings.length > 0) {
    console.log(findings.join("\n"));
    process.exit(1);
  }
  console.log(rows.join("\n"));
}

main().catch((error) => {
  console.error(`coverage-floor-check: ${error.message}`);
  process.exit(2);
});
