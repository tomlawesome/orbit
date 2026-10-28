/**
 * The per-package coverage ratchet gate, scripts/ci/coverage-floor-check.mjs
 * (#1099, adopting birdcage's ratchet).
 *
 * The gate reads a Vitest json-summary file and a floors module, and fails when
 * a directory's coverage is below its floor (BELOW), more than `headroom` points
 * above it so the floor must be raised (HEADROOM), when a top-level `src/`
 * directory has no floor (NO FLOOR), or when a floor matches no file (NO FILES).
 * Every finding is printed; any finding exits 1.
 *
 * Written from the specification before the script existed. This drives the
 * real script with spawnSync against fixture summaries and fixture floors
 * modules in a scratch directory, passed with --summary, --floors and --root.
 * Summary keys are absolute paths under the fixture root, as Vitest writes them.
 *
 * Uses node:test, not vitest globals, like the other script-driving suites
 * (scripts/ci/repin-base-image.test.mjs). Run standalone:
 * `node --test scripts/ci/coverage-floor-check.test.mjs`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";

import { failOnProcessDeadline, processGuard } from "../process-budget.mjs";

const scriptPath = join(import.meta.dirname, "coverage-floor-check.mjs");
const realFloorsPath = join(import.meta.dirname, "..", "..", "supply-chain", "coverage-floors.mjs");

const METRICS = ["statements", "branches", "functions", "lines"];

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function metric([covered, total]) {
  return { total, covered, skipped: 0, pct: total === 0 ? 100 : (100 * covered) / total };
}

/** A file entry with the same [covered, total] pair on all four metrics. */
function uniform(covered, total) {
  return Object.fromEntries(METRICS.map((m) => [m, [covered, total]]));
}

/**
 * Write a json-summary under `root` from `{ relativePath: { metric: [covered, total] } }`.
 * Metrics left out get total 0. Returns the summary path.
 */
function writeSummary(dir, root, files) {
  const summary = {};
  for (const [relativePath, metrics] of Object.entries(files)) {
    summary[join(root, relativePath)] = Object.fromEntries(
      METRICS.map((m) => [m, metric(metrics[m] ?? [0, 0])]),
    );
  }
  summary.total = Object.fromEntries(METRICS.map((m) => [m, metric([0, 0])]));
  const path = join(dir, "coverage-summary.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary));
  return path;
}

/** Write a floors module. `floors` maps key to a single number (all metrics) or a metrics object. */
function writeFloors(dir, floors, headroom = 5) {
  const expanded = Object.fromEntries(
    Object.entries(floors).map(([key, value]) => [
      key,
      typeof value === "number" ? Object.fromEntries(METRICS.map((m) => [m, value])) : value,
    ]),
  );
  const path = join(dir, "floors.mjs");
  writeFileSync(
    path,
    `export const floors = ${JSON.stringify(expanded)};\nexport const headroom = ${headroom};\n`,
  );
  return path;
}

/** Run the gate against `files` and `floors`; returns { status, stdout, stderr, lines }. */
function runGate(files, floors) {
  const dir = scratchDir("coverage-floor-");
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  const summary = writeSummary(dir, root, files);
  const floorsPath = writeFloors(dir, floors);
  return spawn(["--summary", summary, "--floors", floorsPath, "--root", root]);
}

function spawn(args) {
  const result = failOnProcessDeadline(
    spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      ...processGuard(),
    }),
    { label: "coverage-floor-check.mjs" },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: result.stdout.split("\n").filter((line) => line.trim() !== ""),
  };
}

function findings(result, word) {
  return result.lines.filter((line) => line.startsWith(word));
}

describe("coverage-floor-check.mjs", () => {
  it("passes with exit 0 and no findings when coverage sits within the band", () => {
    const result = runGate({ "src/cli/a.ts": uniform(52, 100) }, { "src/cli": 50 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const word of ["BELOW", "HEADROOM", "NO FLOOR", "NO FILES"]) {
      assert.equal(findings(result, word).length, 0);
    }
  });

  it("fails with BELOW when coverage is under the floor", () => {
    const result = runGate({ "src/cli/a.ts": uniform(49, 100) }, { "src/cli": 50 });
    assert.equal(result.status, 1);
    const below = findings(result, "BELOW");
    assert.equal(below.length, METRICS.length);
    for (const metricName of METRICS) {
      assert.ok(below.some((line) => line.includes("src/cli") && line.includes(metricName)));
    }
    assert.ok(below[0].includes("49"), below[0]);
    assert.ok(below[0].includes("50"), below[0]);
  });

  it("fails with HEADROOM when coverage is more than 5 points above the floor", () => {
    const result = runGate({ "src/cli/a.ts": uniform(5501, 10000) }, { "src/cli": 50 });
    assert.equal(result.status, 1);
    const headroom = findings(result, "HEADROOM");
    assert.equal(headroom.length, METRICS.length);
    assert.ok(headroom[0].includes("src/cli"));
    assert.ok(headroom[0].includes("55.01"), headroom[0]);
    assert.ok(headroom[0].includes("50"), headroom[0]);
  });

  it("passes when coverage is exactly at the floor", () => {
    const result = runGate({ "src/cli/a.ts": uniform(50, 100) }, { "src/cli": 50 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("passes when coverage is exactly floor + 5", () => {
    const result = runGate({ "src/cli/a.ts": uniform(55, 100) }, { "src/cli": 50 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("fails with NO FLOOR for a src/ top-level directory that has files but no floor key", () => {
    const result = runGate(
      { "src/cli/a.ts": uniform(50, 100), "src/newthing/b.ts": uniform(50, 100) },
      { "src/cli": 50 },
    );
    assert.equal(result.status, 1);
    const noFloor = findings(result, "NO FLOOR");
    assert.equal(noFloor.length, 1);
    assert.ok(noFloor[0].includes("src/newthing"), noFloor[0]);
  });

  it("fails with NO FILES for a floor key that matches no file in the summary", () => {
    const result = runGate({ "src/cli/a.ts": uniform(50, 100) }, { "src/cli": 50, "src/gone": 50 });
    assert.equal(result.status, 1);
    const noFiles = findings(result, "NO FILES");
    assert.equal(noFiles.length, 1);
    assert.ok(noFiles[0].includes("src/gone"), noFiles[0]);
  });

  it("matches on a directory boundary, not a bare string prefix", () => {
    const result = runGate(
      { "src/cli/a.ts": uniform(50, 100), "src/cliextra/b.ts": uniform(50, 100) },
      { "src/cli": 50 },
    );
    assert.equal(result.status, 1);
    assert.equal(findings(result, "NO FLOOR").length, 1);
    assert.ok(findings(result, "NO FLOOR")[0].includes("src/cliextra"));
    assert.equal(findings(result, "BELOW").length, 0);
    assert.equal(findings(result, "HEADROOM").length, 0);
  });

  it("reports every finding in one run, not just the first", () => {
    const result = runGate(
      {
        "src/cli/a.ts": uniform(40, 100),
        "src/server/b.ts": uniform(5501, 10000),
        "src/newthing/c.ts": uniform(50, 100),
      },
      { "src/cli": 50, "src/server": 50, "src/gone": 50 },
    );
    assert.equal(result.status, 1);
    assert.ok(findings(result, "BELOW").some((line) => line.includes("src/cli")));
    assert.ok(findings(result, "HEADROOM").some((line) => line.includes("src/server")));
    assert.ok(findings(result, "NO FLOOR").some((line) => line.includes("src/newthing")));
    assert.ok(findings(result, "NO FILES").some((line) => line.includes("src/gone")));
  });

  it("aggregates a file into both a nested key and its parent", () => {
    // The nested directory is at 40%, the sibling file at 100%; the parent
    // aggregates both: (40 + 100) / 200 = 70%.
    const files = {
      "src/server/documents/x.ts": uniform(40, 100),
      "src/server/other.ts": uniform(100, 100),
    };
    const result = runGate(files, { "src/server": 70, "src/server/documents": 50 });
    assert.equal(result.status, 1);
    const below = findings(result, "BELOW");
    assert.equal(below.length, METRICS.length);
    assert.ok(below.every((line) => line.includes("src/server/documents")));
    // The parent measured 70% against a floor of 70: no finding names it.
    assert.ok(result.lines.every((line) => !/src\/server(?!\/documents)/.test(line)), result.stdout);
  });

  it("counts a nested file towards the parent's percentage", () => {
    // Parent floor 70 passes only if the nested file is counted (70%); counting
    // only the sibling would give 100% and trip HEADROOM.
    const files = {
      "src/server/documents/x.ts": uniform(40, 100),
      "src/server/other.ts": uniform(100, 100),
    };
    const result = runGate(files, { "src/server": 70, "src/server/documents": 40 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("skips a metric whose summed total is 0", () => {
    // Branches has total 0 everywhere, so the floor of 90 must not produce BELOW.
    const result = runGate(
      {
        "src/cli/a.ts": {
          statements: [50, 100],
          functions: [50, 100],
          lines: [50, 100],
          branches: [0, 0],
        },
      },
      { "src/cli": { statements: 50, functions: 50, lines: 50, branches: 90 } },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(findings(result, "BELOW").length, 0);
  });

  it("applies floors to the scripts directory key", () => {
    const result = runGate({ "scripts/tool.mjs": uniform(10, 100) }, { scripts: 50 });
    assert.equal(result.status, 1);
    assert.equal(findings(result, "BELOW").length, METRICS.length);
    assert.ok(findings(result, "BELOW").every((line) => line.includes("scripts")));
  });

  it("exits non-zero when the summary file is missing", () => {
    const dir = scratchDir("coverage-floor-");
    const floorsPath = writeFloors(dir, { "src/cli": 50 });
    const result = spawn(["--summary", join(dir, "absent.json"), "--floors", floorsPath, "--root", dir]);
    assert.notEqual(result.status, 0);
  });

  it("exits non-zero when the floors module cannot be loaded", () => {
    const dir = scratchDir("coverage-floor-");
    const root = join(dir, "repo");
    mkdirSync(root, { recursive: true });
    const summary = writeSummary(dir, root, { "src/cli/a.ts": uniform(50, 100) });
    const result = spawn(["--summary", summary, "--floors", join(dir, "absent.mjs"), "--root", root]);
    assert.notEqual(result.status, 0);
  });
});

describe("supply-chain/coverage-floors.mjs", () => {
  it("loads, has headroom 5, and every entry has exactly four integer metrics in 0..100", async () => {
    const mod = await import(pathToFileURL(realFloorsPath).href);
    assert.equal(mod.headroom, 5);
    assert.ok(mod.floors && typeof mod.floors === "object");
    const keys = Object.keys(mod.floors);
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.ok(key === "scripts" || key.startsWith("src/"), `unexpected floor key ${key}`);
      assert.deepEqual(Object.keys(mod.floors[key]).sort(), [...METRICS].sort(), key);
      for (const metricName of METRICS) {
        const value = mod.floors[key][metricName];
        assert.ok(Number.isInteger(value) && value >= 0 && value <= 100, `${key}.${metricName}=${value}`);
      }
    }
  });
});
