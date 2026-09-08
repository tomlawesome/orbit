import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CI_LANE } from "./classify-changed-paths.mjs";

// #889: `classify` hands the pipeline a lane, and each job decides for itself
// whether that lane runs it. Nothing else checks the two halves agree -- a
// mistyped job name in `orbit_lane_admits` reads as a job the lane never
// names, so it would skip in every narrow lane and no test would notice until
// somebody wondered where a check had gone. This is that test.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level blocks by name, the same shape scripts/gitlab-ci-runner-hygiene
// .test.mjs reads: a line that is `name:` at column zero, with or without an
// `&anchor |` after it, up to the next such line.
function blocks() {
  const found = new Map();
  const headers = [...gitlabCi.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : gitlabCi.length;
    found.set(match[1], gitlabCi.slice(start, end));
  });
  return found;
}

const allBlocks = blocks();
const jobs = [...allBlocks].filter(([name]) => !name.startsWith("."));

// The lane membership this pipeline is meant to have. `gitleaks` is named in
// both lanes for the record but has no guard of its own to check: it starts
// before `classify`, so it never sees ORBIT_LANE and always runs.
const laneMembers = {
  [CI_LANE.IGNORE_POLICY]: ["gitleaks", "licence_policy", "supply_chain_source"],
  [CI_LANE.CI]: ["fast", "gitleaks", "supply_chain_source"],
};

function guardedJobs() {
  return jobs
    .filter(([, block]) => /orbit_lane_admits /u.test(block))
    .map(([name, block]) => ({ name, block }));
}

// Every `<lane>:<job>)` pattern the shell function matches, as pairs. The
// function is a `case` over "$ORBIT_LANE:$jobname", so its patterns are the
// membership lists themselves.
function admissions() {
  const helper = allBlocks.get(".reach_helpers");
  const body = helper.slice(helper.indexOf("orbit_lane_admits() {"));
  const arms = [...body.matchAll(/^ {6}(\S.*?)\) return 0 ;;$/gmu)];
  return arms.flatMap((arm) =>
    arm[1].split(" | ").map((pattern) => {
      const [lane, job] = pattern.split(":");
      return [lane, job];
    }),
  );
}

describe("pipeline lanes", () => {
  it("guards every job a narrow lane can skip", () => {
    expect(guardedJobs().map(({ name }) => name).sort()).toEqual([
      "acceptance",
      "base_image",
      "build_image",
      "fast",
      "fidelity",
      "integration",
      "licence_policy",
      "repair_journeys",
      "sidecar_images",
      "smoke",
      "supply_chain_image",
      "supply_chain_source",
    ]);
  });

  it("passes each job its own name, so a lane list means what it says", () => {
    for (const { name, block } of guardedJobs()) {
      const calls = [...block.matchAll(/orbit_lane_admits (\S+)/gu)].map((match) => match[1]);
      expect(calls).toEqual([name]);
    }
  });

  it("defines the helpers before calling them, and waits for the lane", () => {
    for (const { name, block } of guardedJobs()) {
      // Same shell, so *reach_helpers has to come first in `script:`.
      expect(block.indexOf("*reach_helpers"), name).toBeGreaterThan(-1);
      expect(block.indexOf("*reach_helpers"), name).toBeLessThan(block.indexOf("orbit_lane_admits"));
      // ORBIT_LANE arrives as a dotenv artifact, so a job that reads it must
      // need `classify` and take its artifacts.
      expect(/needs:\n(?:.*\n)*?\s+- job: classify\n\s+artifacts: true\n/u.test(block), name).toBe(true);
    }
  });

  it("names the classifier's lanes and only those", () => {
    const named = new Set(admissions().map(([lane]) => lane));
    expect([...named].sort()).toEqual([CI_LANE.CI, CI_LANE.FULL, CI_LANE.IGNORE_POLICY].sort());
  });

  it("runs exactly the jobs each lane is meant to run", () => {
    for (const [lane, expected] of Object.entries(laneMembers)) {
      const admitted = admissions()
        .filter(([candidate]) => candidate === lane)
        .map(([, job]) => job);
      expect([...new Set(admitted)].sort(), lane).toEqual([...expected].sort());
    }
    // The full lane admits everything with one wildcard rather than a list.
    expect(admissions().filter(([lane]) => lane === CI_LANE.FULL)).toEqual([[CI_LANE.FULL, "*"]]);
  });

  it("hands the lane on from classify as a dotenv variable", () => {
    const classify = allBlocks.get("classify");
    expect(classify).toMatch(/printf 'ORBIT_LANE=%s\\n' "\$lane" >> classify\.env/u);
    // A lane is a merge-request economy: every delivery push and the merge
    // request into `main` collapse it to `full` and run everything.
    expect(classify).toMatch(/dev \| preview \| main \| hotfix\/\*\) lane=full ;;/u);
    expect(classify).toMatch(/CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-\}" = "main" \]/u);
  });
});
