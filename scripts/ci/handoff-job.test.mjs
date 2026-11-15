import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { OTHER_EVENTS, BATCH_EVENTS, pipelineOf } from "../test-support/ci-simulate.mjs";
import { jobBlock, jobNamesOf, readCi } from "../test-support/gitlab-ci.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * #1824: GitLab hands the tested image and release files to the separate
 * public handoff repository (GITHUB_HANDOFF_REPO, a CI variable: no owner name
 * is written in a tracked file) in a job of the push pipelines that publish,
 * prunes old handoffs there afterwards, and a failed handoff turns the pipeline
 * red.
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

  it("takes the handoff repository and token from CI variables, and knows no other GitHub repository", () => {
    const block = jobBlock("handoff_to_github", ci);
    expect(block).toContain("GITHUB_HANDOFF_REPO");
    expect(block).toContain("GITHUB_HANDOFF_TOKEN");
    // Orbit's own repository is not this job's business.
    expect(block).not.toMatch(/\bGITHUB_REPOSITORY\b/u);
    expect(block).not.toMatch(/tomlawesome\/orbit\b(?!-handoff)/u);
  });

  it("stops early, clearly, when GITHUB_HANDOFF_REPO or GITHUB_HANDOFF_TOKEN is not set", () => {
    const block = jobBlock("handoff_to_github", ci);
    expect(block).toMatch(/-z "\$\{GITHUB_HANDOFF_REPO:-\}"|GITHUB_HANDOFF_REPO:\?/u);
    expect(block).toMatch(/-z "\$\{GITHUB_HANDOFF_TOKEN:-\}"|GITHUB_HANDOFF_TOKEN:\?/u);
  });

  it("runs the prune script after a successful upload, and a failed prune is not hidden", () => {
    const block = jobBlock("handoff_to_github", ci);
    const upload = block.indexOf("scripts/ci/github-upload-handoff.sh");
    const prune = block.indexOf("scripts/ci/github-prune-handoffs.sh");
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(prune).toBeGreaterThan(upload);
    // Only a successful upload reaches it: they are separate script lines under set -e
    // semantics, or one command chained with &&.
    const line = block.slice(block.lastIndexOf("\n", prune), block.indexOf("\n", prune));
    expect(line).not.toMatch(/\|\|\s*(?:true|:|echo)\b/u);
    expect(line).not.toMatch(/;\s*$/u);
    // The prune uses the same handoff token and repository, never GH_TOKEN of GitHub's own.
    expect(block).not.toMatch(/\bGH_TOKEN\b/u);
  });

  it("declares an environment, so the owner can scope GITHUB_HANDOFF_TOKEN to it, and docs/releasing.md says so", () => {
    const block = jobBlock("handoff_to_github", ci);
    const match = /^ {2}environment:\s*(?:\n {4}name:\s*)?([A-Za-z0-9._\/-]+)\s*$/mu.exec(block);
    expect(match, "an environment: with a plain name").not.toBeNull();
    const name = match[1];
    const docs = readFileSync(new URL("../../docs/releasing.md", import.meta.url), "utf8");
    expect(docs).toContain(name);
    expect(docs).toMatch(/environment scope/iu);
    // The instruction sits with the token's section, not somewhere unrelated.
    const section = docs.slice(docs.indexOf("The GitHub handoff token"));
    expect(section).toContain(name);
    expect(section).toMatch(/environment scope/iu);
  });

  it("no other job holds an environment of that name's scope by accident: only this job declares it", () => {
    const block = jobBlock("handoff_to_github", ci);
    const name = /^ {2}environment:\s*(?:\n {4}name:\s*)?([A-Za-z0-9._\/-]+)\s*$/mu.exec(block)?.[1];
    expect(name).toBeDefined();
    const declared = [...ci.matchAll(new RegExp(`^ {2}environment:\\s*(?:\\n {4}name:\\s*)?${name}\\s*$`, "gmu"))];
    expect(declared).toHaveLength(1);
  });

  it("every env -u strip list that names the project's secrets also strips GITHUB_HANDOFF_TOKEN", () => {
    const lists = ci.split("\n").filter((line) => /\benv\b(?: -u \S+)+/u.test(line) && /-u ORBIT_READ_TOKEN\b/u.test(line));
    expect(lists.length).toBeGreaterThan(0);
    for (const line of lists) expect(line).toMatch(/ -u GITHUB_HANDOFF_TOKEN\b/u);
  });

  it("sign_evidence signs the SBOM's sha256 into the predicate: it needs supply_chain_image and names the SBOM file", () => {
    const block = jobBlock("sign_evidence", ci);
    expect(needsOf("sign_evidence")).toContain("supply_chain_image");
    expect(block).toMatch(/ORBIT_SBOM_FILE=\S*\.orbit-supply-chain\/image\.spdx\.json/u);
    expect(block).toContain("scripts/ci/attest-tested-image.sh");
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
  }, 30_000);

  it("runs wherever record_image runs on a push, so a publishable build always has a handoff", () => {
    for (const event of ["pushPreview", "pushHotfix"]) {
      const jobs = pipelineOf(OTHER_EVENTS[event], ci, templates).jobs;
      expect(jobs.record_image, event).toBe("run");
      expect(jobs.handoff_to_github, event).toBe("run");
    }
  });
});

describe("no owner name in a tracked file (#1824)", () => {
  it("the handoff repository is only ever named <owner>/orbit-handoff, from a variable, never with a real owner", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const result = spawnSync(
      "/usr/bin/git",
      ["grep", "-n", "-I", "-E", "[A-Za-z0-9][A-Za-z0-9._-]*/orbit-handoff", "--", ".", ":(exclude)scripts/ci/handoff-job.test.mjs"],
      { cwd: root, encoding: "utf8" },
    );
    expect([0, 1], result.stderr).toContain(result.status);
    // Placeholders for the reader (owner, example-owner) are fine.
    const real = result.stdout
      .split("\n")
      .filter(Boolean)
      .filter((line) => [...line.matchAll(/([A-Za-z0-9][A-Za-z0-9._-]*)\/orbit-handoff/gu)].some((m) => !/^(?:owner|example-owner|your-owner|OWNER)$/u.test(m[1])));
    expect(real).toEqual([]);
  });
});
