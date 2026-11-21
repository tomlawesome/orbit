// Pins the local worker cap and the load warning (#1864).
//
// Seams assumed (the fix must provide them):
//  - scripts/test-workers.mjs exporting testWorkers({ env, cpus }) ->
//    { maxWorkers } | {} (CI set, no override); throws on a bad ORBIT_TEST_WORKERS.
//  - vitest.config.ts imports and calls it.
//  - scripts/test-load-warning.sh, called by scripts/test-backend.sh, reading
//    ORBIT_TEST_LOAD1 (1-minute load) and ORBIT_TEST_CPUS (CPU count) when set,
//    printing one line when load > cpus, nothing otherwise, always exit 0.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const load = () => import("./test-workers.mjs");

describe("testWorkers (#1864)", () => {
  it.each([
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 2],
    [8, 4],
    [16, 8],
    [32, 8],
    [128, 8],
  ])("P1: %i cpus, CI unset -> %i workers", async (cpus, want) => {
    const { testWorkers } = await load();
    expect(testWorkers({ env: {}, cpus })).toEqual({ maxWorkers: want });
  });

  it("P2: override sets the cap in the local profile", async () => {
    const { testWorkers } = await load();
    expect(testWorkers({ env: { ORBIT_TEST_WORKERS: "3" }, cpus: 32 })).toEqual({
      maxWorkers: 3,
    });
  });

  it("P2: override sets the cap in the CI profile", async () => {
    const { testWorkers } = await load();
    expect(
      testWorkers({ env: { CI: "true", ORBIT_TEST_WORKERS: "64" }, cpus: 4 }),
    ).toEqual({ maxWorkers: 64 });
  });

  it.each(["0", "65", "-1", "1.5", "abc", "", " 4", "4x", "1e1"])(
    "P2: bad ORBIT_TEST_WORKERS %j throws naming the variable",
    async (bad) => {
      const { testWorkers } = await load();
      expect(() => testWorkers({ env: { ORBIT_TEST_WORKERS: bad }, cpus: 8 })).toThrow(
        /ORBIT_TEST_WORKERS/,
      );
    },
  );

  it("P3: CI set, no override -> no worker settings", async () => {
    const { testWorkers } = await load();
    expect(testWorkers({ env: { CI: "true" }, cpus: 32 })).toEqual({});
  });
});

describe("vitest.config.ts (#1864)", () => {
  it("imports and uses testWorkers, keeps the timeouts", () => {
    const src = read("vitest.config.ts");
    expect(src).toMatch(/from\s+["']\.\/scripts\/test-workers\.mjs["']/);
    expect(src).toMatch(/testWorkers\(/);
    // #1933 81a: 15 s in CI, 5 s locally.
    expect(src).toMatch(/testTimeout:\s*process\.env\.CI === "true" \? 15_000 : 5_000/);
    expect(src).toMatch(/hookTimeout:\s*10_000/);
  });
});

describe("load warning (#1864)", () => {
  const warn = (load1, cpus) => {
    const script = join(root, "scripts/test-load-warning.sh");
    expect(existsSync(script)).toBe(true);
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, ORBIT_TEST_LOAD1: load1, ORBIT_TEST_CPUS: cpus },
    });
  };

  it("P4: one line naming timeouts, wait and ORBIT_TEST_WORKERS when load > cpus", () => {
    const r = warn("12.50", "8");
    expect(r.status).toBe(0);
    const lines = `${r.stdout}${r.stderr}`.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/timeout/i);
    expect(lines[0]).toMatch(/wait/i);
    expect(lines[0]).toMatch(/ORBIT_TEST_WORKERS/);
  });

  it.each([
    ["8.00", "8"],
    ["3.2", "8"],
  ])("P4: silent when load %s <= %s cpus", (l, c) => {
    const r = warn(l, c);
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`.trim()).toBe("");
  });

  it("P4: the gate calls the helper before running tests", () => {
    expect(read("scripts/test-backend.sh")).toMatch(/test-load-warning\.sh/);
  });
});

describe("docs (#1864)", () => {
  const doc = () => read("docs/testing.md");

  it("P5: one full suite at a time", () => {
    expect(doc()).toMatch(/one full (test )?suite at a time/i);
  });

  it("P5: local default cap and ORBIT_TEST_WORKERS", () => {
    const d = doc();
    expect(d).toMatch(/ORBIT_TEST_WORKERS/);
    expect(d).toMatch(/availableParallelism|half (of )?the (CPUs|cores|CPU count)/i);
    expect(d).toMatch(/\b8\b/);
  });

  it("P5: timeout-only failure under the load warning is re-run, not trusted", () => {
    const d = doc();
    expect(d).toMatch(/load warning/i);
    expect(d).toMatch(/re-?run/i);
    expect(d).toMatch(/timeout/i);
  });
});
