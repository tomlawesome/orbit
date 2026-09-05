import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #823: the runner host ran out of disk. Part of it was ours -- a job that
// starts its own Docker daemon leaves the daemon's image store in the slot's
// /builds volume, which outlives the job. This pins the rule that every such
// job tears the store down on its way out, whatever else its after_script does.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level job blocks by name: a line that is `name:` at column zero, with
// or without an `&anchor |` after it, up to the next such line. Anchors
// (`.name:`) are included and filtered below.
function jobBlocks() {
  const blocks = new Map();
  const headers = [...gitlabCi.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : gitlabCi.length;
    blocks.set(match[1], gitlabCi.slice(start, end));
  });
  return blocks;
}

function afterScriptEntries(block) {
  const start = block.indexOf("\n  after_script:\n");
  if (start < 0) {
    return null;
  }
  const rest = block.slice(start + "\n  after_script:\n".length);
  // The section ends at the next key indented two spaces (artifacts:, rules:,
  // ...) or at the end of the block.
  const end = rest.search(/^ {2}[a-z_]+:/mu);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^ {4}- (.*)$/gmu)].map((match) => match[1].trim());
}

describe("in-job Docker daemons clean up after themselves (#823)", () => {
  const jobs = [...jobBlocks()].filter(
    ([name, block]) => !name.startsWith(".") && block.includes("- *docker_in_job\n"),
  );

  it("covers the jobs known to start a daemon", () => {
    expect(jobs.map(([name]) => name).sort()).toEqual(
      ["acceptance", "launcher_install_compat", "repair_journeys", "smoke", "supply_chain_image"].sort(),
    );
  });

  it.each(jobs.map(([name, block]) => [name, block]))(
    "%s ends its after_script with the teardown",
    (_name, block) => {
      const entries = afterScriptEntries(block);
      expect(entries, "after_script is missing").not.toBeNull();
      expect(entries.at(-1)).toBe("*docker_in_job_teardown");
    },
  );

  it("stops the daemon before removing its store, and removes the scanner temp too", () => {
    const anchor = jobBlocks().get(".docker_in_job_teardown");
    expect(anchor).toBeDefined();
    const killAt = anchor.indexOf("kill ");
    const removeAt = anchor.indexOf("rm -rf");
    expect(killAt).toBeGreaterThan(0);
    expect(removeAt).toBeGreaterThan(killAt);
    expect(anchor).toContain('.orbit-docker-data" || :');
    expect(anchor).toContain('rm -rf "$RUNNER_TEMP" || :');
  });
});

// #829: a working branch's first push and its merge request, opened seconds
// later, each ran a full pipeline for the same commit, doubling Orbit's share
// of the shared runner. Pushes start a pipeline on the long-lived branches
// only; everything else is tested by its merge request.
describe("a push starts a pipeline on the long-lived branches only (#829)", () => {
  const workflow = jobBlocks().get("workflow");
  const rules = [...workflow.matchAll(/^ {4}- if: (.*)$(?:\n {6}when: (\S+))?/gmu)].map((match) => ({
    condition: match[1],
    when: match[2] ?? "always",
  }));
  const pushGuard = rules.find(({ condition }) => condition.startsWith('$CI_PIPELINE_SOURCE == "push" &&'));

  it("refuses a push pipeline on any other branch", () => {
    expect(pushGuard, "the push guard is missing").toBeDefined();
    expect(pushGuard.when).toBe("never");
    for (const branch of ["dev", "preview", "main"]) {
      expect(pushGuard.condition).toContain(`$CI_COMMIT_BRANCH != "${branch}"`);
    }
    expect(pushGuard.condition).toContain("$CI_COMMIT_BRANCH !~ /^hotfix\\//");
  });

  it("keeps the catch-all for pipelines started by hand, after the guard", () => {
    const catchAll = rules.findIndex(({ condition, when }) => condition === "$CI_COMMIT_BRANCH" && when === "always");
    expect(catchAll).toBeGreaterThan(rules.indexOf(pushGuard));
  });
});

// #834 (part 1): an artifacts block with no expire_in keeps its files forever,
// which is exactly the kind of unbounded growth #823 was about. This only
// pins the expiry; the pull_policy and registry-retention parts of #834 are
// separate and need the owner first.
function artifactsSection(block) {
  const start = block.indexOf("\n  artifacts:\n");
  if (start < 0) {
    return null;
  }
  const rest = block.slice(start + "\n  artifacts:\n".length);
  // Same rule as afterScriptEntries: the section ends at the next key
  // indented two spaces, or at the end of the block.
  const end = rest.search(/^ {2}[a-z_]+:/mu);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("every artifacts block has an expire_in (#834)", () => {
  const jobsWithArtifacts = [...jobBlocks()].filter(
    ([, block]) => artifactsSection(block) !== null,
  );

  it("found at least one job with an artifacts block", () => {
    // Guards the guard: if nobody pins artifacts any more this test would
    // otherwise pass vacuously.
    expect(jobsWithArtifacts.length).toBeGreaterThan(0);
  });

  it.each(jobsWithArtifacts.map(([name, block]) => [name, block]))(
    "%s sets expire_in on its artifacts",
    (_name, block) => {
      const section = artifactsSection(block);
      expect(section).toMatch(/^ {4}expire_in: /mu);
    },
  );
});
