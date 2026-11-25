import { describe, expect, it } from "vitest";

import { jobBlocks, readCi } from "./test-support/gitlab-ci.mjs";

/*
 * #1933 (103a): `fast` runs as two `parallel:` shards and a new `fast_coverage`
 * job merges their Vitest blobs and enforces the coverage floors. Written from
 * the architecture ruling alone; every test here fails on dev, before the
 * change. Run: pnpm exec vitest run scripts/gitlab-ci-fast-shards-1933.test.mjs
 */
const ci = readCi();
const blocks = jobBlocks(ci);
const block = (name) => blocks.get(name) ?? "";
const entryIn = (text, job) => {
  const m = text.match(new RegExp(`^( *)- job: ${job}\\n((?:\\1 {2}[^\\n]*\\n)*)`, "mu"));
  return m ? m[0] : null;
};

describe("fast is two shards (#1933)", () => {
  it("has parallel: 2 and keeps its 30m timeout, stage, needs and GIT_DEPTH", () => {
    const fast = block("fast");
    expect(fast).toMatch(/^ {2}parallel: 2\s*$/mu);
    expect(fast).toMatch(/^ {2}timeout: 30m\s*$/mu);
    expect(fast).toMatch(/^ {2}stage: fast\s*$/mu);
    expect(fast).toMatch(/GIT_DEPTH: 0/u);
    expect(fast).toMatch(/needs:\n {4}- job: classify/u);
  });

  it("passes its shard to test-backend.sh as ORBIT_TEST_SHARD=$CI_NODE_INDEX/$CI_NODE_TOTAL", () => {
    expect(block("fast")).toContain("ORBIT_TEST_SHARD=$CI_NODE_INDEX/$CI_NODE_TOTAL");
  });

  it("uploads the vitest blob and evidence, no coverage/ directory, for 8 days", () => {
    const artifacts = block("fast").match(/^ {2}artifacts:\n((?: {4}[^\n]*\n)+)/mu)?.[1] ?? "";
    expect(artifacts).toContain(".vitest/blob/");
    expect(artifacts).toContain("ci-evidence/");
    expect(artifacts).not.toMatch(/coverage\//u);
    expect(artifacts).toMatch(/expire_in: 8 days/u);
  });

  it("names the run-mode decision once, as the .fast_run_mode anchor, used by fast and fast_coverage", () => {
    expect(ci).toMatch(/^\.fast_run_mode: &fast_run_mode$/mu);
    expect(block("fast")).toContain("*fast_run_mode");
    expect(block("fast_coverage")).toContain("*fast_run_mode");
    expect(block(".fast_run_mode")).toContain("ORBIT_TEST_CHANGED_BASE");
  });
});

describe("fast_coverage (#1933)", () => {
  it("exists in stage fast on the light runner, extending .node, with a 10m timeout", () => {
    const job = block("fast_coverage");
    expect(job).not.toBe("");
    expect(job).toMatch(/^ {2}stage: fast\s*$/mu);
    expect(job).toMatch(/^ {2}tags: \[light\]\s*$/mu);
    expect(job).toMatch(/^ {2}extends: \.node\s*$/mu);
    expect(job).toMatch(/^ {2}timeout: 10m\s*$/mu);
    expect(job).toMatch(/GIT_DEPTH: 0/u);
  });

  it("has the same rules list as fast", () => {
    const rules = (name) => block(name).match(/^ {2}rules:\n((?: {4}[^\n]*\n)+)/mu)?.[1];
    expect(rules("fast_coverage")).toBeDefined();
    expect(rules("fast_coverage")).toBe(rules("fast"));
  });

  it("needs classify and fast, both with artifacts", () => {
    const job = block("fast_coverage");
    expect(job).toMatch(/- job: classify\n\s+artifacts: true/u);
    expect(job).toMatch(/- job: fast\n\s+artifacts: true/u);
  });

  it("is admitted by its lane and gated by the reuse gate", () => {
    const job = block("fast_coverage");
    expect(job).toContain("orbit_lane_admits fast_coverage || exit 0");
    expect(job).toContain("*reuse_gate");
    expect(job).toContain("*reuse_evidence");
  });

  it("fetches the blobs, merges them without ORBIT_TEST_SHARD, then runs the floor check, in that order", () => {
    const job = block("fast_coverage");
    const blobs = job.indexOf("scripts/ci/fast-coverage-blobs.sh 2");
    const merge = job.indexOf("--merge-reports .vitest/blob");
    const floors = job.indexOf("scripts/ci/coverage-floor-check.mjs");
    expect(blobs).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(blobs);
    expect(floors).toBeGreaterThan(merge);
    expect(job).toContain("--coverage.enabled=true");
    expect(job).toContain("--reporter=dot");
    expect(job).not.toContain("ORBIT_TEST_SHARD");
  });

  it("publishes coverage/ and ci-evidence/ as orbit-coverage for 7 days", () => {
    const job = block("fast_coverage");
    expect(job).toMatch(/name: orbit-coverage/u);
    expect(job).toMatch(/coverage\//u);
    expect(job).toMatch(/expire_in: 7 days/u);
  });

  it("is in the ci lane's admission list", () => {
    expect(ci).toMatch(/ci:fast \| ci:fast_checks \| ci:fast_docker \| ci:fast_coverage/u);
  });
});

describe("every wait that names fast also names fast_coverage (#1933)", () => {
  const ANCHORS = ["needs_gated", "needs_gated_with_fast_artifacts", "needs_rig", "needs_gated_image", "needs_gated_image_checked"];
  for (const anchor of ANCHORS) {
    it(`.${anchor} waits for fast_coverage, optional and without artifacts`, () => {
      const entry = entryIn(block(`.${anchor}`), "fast_coverage");
      expect(entry, `.${anchor} lists fast_coverage`).not.toBeNull();
      expect(entry).toMatch(/artifacts: false/u);
      expect(entry).toMatch(/optional: true/u);
    });
  }

  for (const job of ["launcher_install_compat", "record_image"]) {
    it(`${job} lists fast_coverage the way it lists fast`, () => {
      const fast = entryIn(block(job), "fast");
      const coverage = entryIn(block(job), "fast_coverage");
      expect(coverage, `${job} lists fast_coverage`).not.toBeNull();
      expect(/optional: true/u.test(coverage)).toBe(/optional: true/u.test(fast));
    });
  }

  it("no needs list that names fast_docker lacks fast_coverage", () => {
    for (const [name, text] of blocks) {
      if (name === "fast_docker" || !/- job: fast_docker\b/u.test(text)) continue;
      expect(text, `${name} names fast_docker`).toMatch(/- job: fast_coverage\b/u);
    }
  });
});
