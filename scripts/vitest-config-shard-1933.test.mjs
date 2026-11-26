import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1933 (103a): coverage thresholds are enforced per run, so they must be off
 * in a shard run (ORBIT_TEST_SHARD set) and on in the merge run and in local
 * runs (unset). A shard adds the blob reporter and writes only text-summary.
 * Written from the ruling alone. Run: pnpm exec vitest run scripts/vitest-config-shard-1933.test.mjs
 */
async function config(shard) {
  vi.resetModules();
  if (shard === undefined) vi.stubEnv("ORBIT_TEST_SHARD", "");
  else vi.stubEnv("ORBIT_TEST_SHARD", shard);
  if (shard === undefined) delete process.env.ORBIT_TEST_SHARD;
  return (await import("../vitest.config.ts")).default.test;
}
afterEach(() => vi.unstubAllEnvs());

describe("vitest.config.ts with ORBIT_TEST_SHARD (#1933)", () => {
  it("turns thresholds off in a shard run", async () => {
    const test = await config("1/2");
    expect(test.coverage.thresholds).toBeUndefined();
    // ... and on, per directory, when the same config is read with no shard (local and merge runs)
    expect(Object.keys((await config(undefined)).coverage.thresholds ?? {}).length).toBeGreaterThan(0);
  });

  it("adds the blob reporter, keeping today's three, in a shard run", async () => {
    const test = await config("2/2");
    expect(test.reporters).toEqual(["default", "hanging-process", "./scripts/vitest-progress-reporter.mjs", "blob"]);
    expect((await config(undefined)).reporters).not.toContain("blob");
  });

  it("writes only text-summary coverage in a shard run", async () => {
    const test = await config("1/2");
    expect(test.coverage.reporter).toEqual(["text-summary"]);
    expect((await config(undefined)).coverage.reporter).toEqual(["text-summary", "json-summary", "html"]);
  });
});
