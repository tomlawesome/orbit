import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { denyGlobs, jobNames, readConfig, shardNames, selects, definitionCoversPipeline } from "./job-inputs.mjs";

/*
 * #1933 (103a): reuse keys for the two `fast` shards and for fast_coverage.
 * Written from the ruling alone. Run: pnpm exec vitest run scripts/ci/job-inputs-fast-shards-1933.test.mjs
 */
const raw = JSON.parse(readFileSync(new URL("./job-inputs.json", import.meta.url), "utf8"));
const config = readConfig();

describe("job-inputs for the sharded fast job (#1933)", () => {
  it("declares fast with 2 shards", () => {
    expect(raw.jobs.fast.shards).toBe(2);
    expect(raw.jobs.fast.deny).toEqual(["@source_only"]);
    expect(shardNames(config, "fast")).toEqual(["fast 1/2", "fast 2/2"]);
  });

  it("declares fast_coverage as a candidate, one job, denying @source_only but taking back the floors", () => {
    expect(jobNames(config)).toContain("fast_coverage");
    expect(raw.jobs.fast_coverage).toEqual({ deny: ["@source_only", "!supply-chain/coverage-floors.mjs"] });
    expect(shardNames(config, "fast_coverage")).toEqual(["fast_coverage"]);
  });

  it("counts supply-chain/coverage-floors.mjs as an input of fast_coverage, but not other supply-chain files", () => {
    const denied = (path) => selects(denyGlobs(config, "fast_coverage"), path);
    expect(denied("supply-chain/coverage-floors.mjs")).toBe(false);
    expect(denied("supply-chain/other.mjs")).toBe(true);
    expect(denied("docs/readme.md")).toBe(true);
  });

  it("does not make a CI definition edit stand for fast_coverage (same as fast)", () => {
    expect(definitionCoversPipeline(config, "fast_coverage")).toBe(definitionCoversPipeline(config, "fast"));
    expect(definitionCoversPipeline(config, "fast_coverage")).toBe(false);
  });
});
