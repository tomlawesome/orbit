import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// This spawns a real `node` process; budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./db-generate-refused.mjs", import.meta.url).pathname;

function run() {
  return failOnProcessDeadline(
    spawnSync(process.execPath, [script], { encoding: "utf8", ...processGuard() }),
    { label: "run" },
  );
}

describe("db:generate refusal (#535)", () => {
  it("exits non-zero and names the stale-snapshot cause, the doc, and the model migration", () => {
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("#535");
    expect(result.stderr).toContain("drizzle/meta/");
    expect(result.stderr).toContain("docs/testing.md");
    expect(result.stderr).toContain("Hand-writing a migration");
    expect(result.stderr).toContain("drizzle/0027_instance_authority.sql");
    expect(result.stdout).toBe("");
  });

  it("is exactly what package.json's db:generate script runs", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["db:generate"]).toBe("node scripts/db-generate-refused.mjs");
  });
});
