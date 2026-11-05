import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BATCH_EVENTS, OTHER_EVENTS, pipelineOf, workflowOf } from "../test-support/ci-simulate.mjs";
import { effectiveRules, jobBlock, jobNamesOf, readCi } from "../test-support/gitlab-ci.mjs";

/*
 * #1720: a merge request into `batch-a` or `batch-b` runs only the quick
 * static checks. The batch reaches `dev` by a merge request that runs the full
 * pipeline after its audit, so the full run on each merge into a batch tested
 * code the audit then changes. Every other pipeline is unchanged.
 *
 * "Unchanged" is checked against fixtures/ci-pipelines-before-1720.json: the
 * jobs each event created at ecee2eb7, the commit before this change, from the
 * same simulation (scripts/test-support/ci-simulate.mjs).
 */
const ci = readCi();
const templates = [
  readFileSync(new URL("../test-support/fixtures/backmerge-skip-v1-ci-template.yml", import.meta.url), "utf8"),
  readFileSync(new URL("../test-support/fixtures/dev-landing-v1-ci-template.yml", import.meta.url), "utf8"),
];
const before = JSON.parse(readFileSync(new URL("../test-support/fixtures/ci-pipelines-before-1720.json", import.meta.url), "utf8"));

// The static checks: secret scan, private details, and the quarantine and
// flake check. Nothing that installs the app's dependencies, builds an image
// or starts a browser or a service.
const STATIC_CHECKS = ["flake_check", "gitleaks", "private-details"];

describe("a merge request into a batch branch (#1720)", () => {
  for (const [event, env] of Object.entries(BATCH_EVENTS)) {
    it(`${event}: creates a pipeline, with the batch-intake variable set`, () => {
      const variables = workflowOf(env, ci, templates);
      expect(variables, "workflow:rules refused the pipeline; pipelines must succeed, so the MR could never merge").not.toBeNull();
      expect(variables).toMatchObject({ BATCH_INTAKE: "true" });
    });

    it(`${event}: runs exactly the static checks, automatically`, () => {
      const { jobs } = pipelineOf(env, ci, templates);
      expect(Object.keys(jobs).sort()).toEqual(STATIC_CHECKS);
      for (const name of STATIC_CHECKS) expect(jobs[name], name).toBe("run");
    });
  }

  it("before #1720, the same merge request ran the full pipeline (the cost this removes)", () => {
    // A guard on the fixture's premise: without the skip, the batch target
    // falls through to the generic merge-request rules and gets everything.
    expect(Object.keys(before.mrIntoBatchLookalike.jobs).length).toBeGreaterThan(STATIC_CHECKS.length + 10);
  });
});

describe("every other pipeline is as it was at ecee2eb7 (#1720)", () => {
  it("the fixture covers every simulated event and nothing else", () => {
    expect(Object.keys(before).sort()).toEqual(Object.keys(OTHER_EVENTS).sort());
  });

  for (const [event, env] of Object.entries(OTHER_EVENTS)) {
    // A push to dev starts the fast-check pipeline since #1737 (dev-landing-ci.test.mjs).
    if (event === "pushDev") continue;
    it(`${event}: same pipeline, same jobs, same verdicts`, () => {
      expect(pipelineOf(env, ci, templates)).toEqual(before[event]);
    });

    it(`${event}: the batch-intake variable is not set`, () => {
      const variables = workflowOf(env, ci, templates);
      expect(variables?.BATCH_INTAKE).toBeUndefined();
    });
  }
});

describe("the skip does not hang on the variable alone (#1720)", () => {
  // A pipeline variable BATCH_INTAKE=true set by hand on a merge request into
  // `dev` must not strip that pipeline's gate.
  it("a stray BATCH_INTAKE=true on a merge request into dev or a push to preview changes no job", () => {
    for (const event of ["mrIntoDev", "pushPreview", "mrIntoMain"]) {
      const env = { ...OTHER_EVENTS[event], BATCH_INTAKE: "true" };
      expect(pipelineOf(env, ci, templates), event).toEqual(before[event]);
    }
  });
});

describe("the static checks still run where they ran (#1720)", () => {
  it("each is a job in .gitlab-ci.yml with no dependency on a skipped job", () => {
    const names = jobNamesOf(ci);
    for (const name of STATIC_CHECKS) {
      expect(names, name).toContain(name);
      expect(effectiveRules(name, ci, templates).length, name).toBeGreaterThan(0);
      // `needs: []`: a need on a job the batch pipeline skips would fail
      // pipeline creation instead of skipping this one.
      expect(jobBlock(name, ci), name).toMatch(/^ {2}needs: \[\]\s*$/mu);
    }
  });
});

describe("the rule is documented (#1720)", () => {
  it("in .gitlab-ci.yml, beside the #113 rule", () => {
    const flat = ci.replace(/\s+/gu, " ");
    expect(flat).toMatch(/#1720/u);
    const at113 = ci.indexOf("ai/agent-infra#113");
    const at1720 = ci.indexOf("#1720");
    expect(at113).toBeGreaterThan(-1);
    expect(Math.abs(at1720 - at113), "the #1720 note sits beside the #113 rule").toBeLessThan(3000);
  });

  it("in docs/releasing.md: a batch merge request runs only the static checks", () => {
    const doc = readFileSync(new URL("../../docs/releasing.md", import.meta.url), "utf8").replace(/\s+/gu, " ");
    expect(doc).toMatch(/#1720/u);
    expect(doc).toMatch(/`batch-a`/u);
    expect(doc).toMatch(/`batch-b`/u);
    for (const name of STATIC_CHECKS) expect(doc, name).toContain(`\`${name}\``);
  });
});
