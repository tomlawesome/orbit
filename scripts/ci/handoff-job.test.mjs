import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { OTHER_EVENTS, BATCH_EVENTS, pipelineOf } from "../test-support/ci-simulate.mjs";
import { jobBlock, jobNamesOf, readCi } from "../test-support/gitlab-ci.mjs";

/*
 * #1824: GitLab hands the tested image and release files to GitHub in a job of
 * the push pipelines that publish, and a failed handoff turns the pipeline red.
 */
const ci = readCi();
const templates = [
  readFileSync(new URL("../test-support/fixtures/backmerge-skip-v1-ci-template.yml", import.meta.url), "utf8"),
  readFileSync(new URL("../test-support/fixtures/dev-landing-v1-ci-template.yml", import.meta.url), "utf8"),
];

function needsOf(name) {
  const m = /^ {2}needs:\s*\n((?: {4}.*\n?)*)/mu.exec(jobBlock(name, ci));
  return m ? [...m[1].matchAll(/^ {4}- (?:job:\s*)?([\w.-]+)/gmu)].map((x) => x[1]) : [];
}

describe("handoff_to_github job (#1824)", () => {
  it("exists", () => {
    expect(jobNamesOf(ci)).toContain("handoff_to_github");
  });

  it("needs the jobs that make the evidence, the signature, the SBOM and the launcher", () => {
    const needs = needsOf("handoff_to_github");
    for (const job of ["record_image", "sign_evidence", "supply_chain_image", "build_launcher"]) {
      expect(needs, job).toContain(job);
    }
  });

  it("is not allowed to fail, so a failed handoff turns the pipeline red", () => {
    const block = jobBlock("handoff_to_github", ci);
    expect(block).not.toMatch(/^ {2}allow_failure:\s*(true|\n\s+exit_codes)/mu);
    expect(block).not.toMatch(/^ {2}when:\s*(manual|on_failure|never)\b/mu);
  });

  it("runs the upload script", () => {
    expect(jobBlock("handoff_to_github", ci)).toContain("scripts/ci/github-upload-handoff.sh");
  });

  it("is created on push pipelines for preview and hotfix/* and on no other event", () => {
    const events = { ...OTHER_EVENTS, ...BATCH_EVENTS };
    const created = Object.entries(events)
      .filter(([, env]) => pipelineOf(env, ci, templates).jobs?.handoff_to_github !== undefined)
      .map(([event]) => event)
      .sort();
    expect(created).toEqual(["pushHotfix", "pushPreview"]);
    for (const event of ["pushPreview", "pushHotfix"]) {
      expect(pipelineOf(events[event], ci, templates).jobs.handoff_to_github, event).toBe("run");
    }
  });

  it("runs wherever record_image runs on a push, so a publishable build always has a handoff", () => {
    for (const event of ["pushPreview", "pushHotfix"]) {
      const jobs = pipelineOf(OTHER_EVENTS[event], ci, templates).jobs;
      expect(jobs.record_image, event).toBe("run");
      expect(jobs.handoff_to_github, event).toBe("run");
    }
  });
});
