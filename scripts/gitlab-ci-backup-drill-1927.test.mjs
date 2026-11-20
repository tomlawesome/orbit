import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { effectiveRules, jobBlocks, jobNamesOf, readCi, stagesOf } from "./test-support/gitlab-ci.mjs";

// #1927 (owner decision 72a): the real-stack backup/restore drill
// `scripts/test-backup-restore.sh --own-stack` runs in a GitLab job on the
// privileged `orbit-build` runner, nightly only, on the existing nightly
// schedule (the one that sets ORBIT_NIGHTLY_BROWSERS=true, #1412). No
// merge-request or push pipeline runs it. A failure fails the pipeline, which
// `nightly_report` (on_failure, `maintenance` stage) files as an issue, like
// the other nightly checks. Tests name the behaviour, not the job's spelling.

const ci = readCi();
const blocks = jobBlocks(ci);
const drillScript = readFileSync(new URL("./test-backup-restore.sh", import.meta.url), "utf8");

// The shared templates are included from another project and are not in this
// checkout. Their rules only ever add exclusions (a dev landing, an empty
// back-merge); a stub that never matches stands in so `!reference` resolves.
const STUB = [
  ".dev-landing:",
  "  job_rule:",
  "    - if: $NEVER_SET_IN_TESTS",
  "      when: never",
  "  workflow_rules:",
  "    - if: $NEVER_SET_IN_TESTS",
  "      when: never",
  ".backmerge-skip:",
  "  job_rule:",
  "    - if: $NEVER_SET_IN_TESTS",
  "      when: never",
  "  workflow_rules:",
  "    - if: $NEVER_SET_IN_TESTS",
  "      when: never",
  "",
].join("\n");

const DRILL_COMMAND = /scripts\/test-backup-restore\.sh\s+--own-stack\b/u;

function scriptLines(block) {
  return block.split("\n").filter((line) => !/^\s*#/u.test(line));
}

function drillJobs() {
  return jobNamesOf(ci).filter((name) => scriptLines(blocks.get(name)).some((line) => DRILL_COMMAND.test(line)));
}

function drillJob() {
  const jobs = drillJobs();
  expect(jobs, "no job runs `scripts/test-backup-restore.sh --own-stack`").toHaveLength(1);
  return jobs[0];
}

function evaluate(expression, env) {
  const value = (name) => {
    const found = env[name];
    return found === undefined || found === "" ? null : found;
  };
  const match = (subject, pattern, negate) => (negate ? !(subject !== null && pattern.test(subject)) : subject !== null && pattern.test(subject));
  const source = expression
    .replace(
      /\$([A-Z][A-Z0-9_]*)\s*(=~|!~)\s*\/((?:\\\/|[^/])*)\//gu,
      (_all, name, operator, pattern) => `match(value("${name}"), new RegExp(${JSON.stringify(pattern.replace(/\\\//gu, "/"))}, "u"), ${operator === "!~"})`,
    )
    .replace(/\$([A-Z][A-Z0-9_]*)/gu, (_all, name) => `value("${name}")`);
  return Boolean(new Function("value", "match", `return (${source});`)(value, match));
}

function verdictOf(rules, env) {
  for (const rule of rules) {
    if (rule.if !== undefined && !evaluate(rule.if, env)) continue;
    const when = rule.when ?? "on_success";
    if (when === "never") return "never";
    if (when === "manual") return "manual";
    if (when === "on_failure") return "failure";
    return "run";
  }
  return "never";
}

function jobVerdict(name, env) {
  if (verdictOf(effectiveRules("workflow", ci, [STUB]), env) === "never") return "never";
  return verdictOf(effectiveRules(name, ci, [STUB]), env);
}

const nightly = { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ORBIT_NIGHTLY_BROWSERS: "true" };

const notNightly = {
  "a merge request into dev": { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/x" },
  "a merge request into preview": { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev" },
  "a merge request into main": { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "main", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "preview" },
  "a push to dev": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "dev" },
  "a push to preview": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "preview" },
  "a push to main": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "main" },
  "a push to a working branch": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "ci/1927-backup-drill-nightly" },
  "a push to a hotfix branch": { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "hotfix/x" },
  "a pipeline started by hand": { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" },
  "a pipeline started through the API": { CI_PIPELINE_SOURCE: "api", CI_COMMIT_BRANCH: "dev" },
  "the Renovate schedule": { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", RENOVATE: "true" },
  "a schedule that sets no nightly variable": { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev" },
};

describe("the backup/restore drill runs in CI (#1927)", () => {
  it("has exactly one job that runs scripts/test-backup-restore.sh --own-stack", () => {
    expect(drillJobs()).toHaveLength(1);
  });

  it("runs on the privileged orbit-build runner, by tag or through .privileged_runner", () => {
    const block = blocks.get(drillJob());
    const extendsRunner = /^ {2}extends:.*\.privileged_runner/mu.test(block) || /^ {2}extends:\s*\n(?: {4}- .*\n)*? {4}- \.privileged_runner\b/mu.test(block);
    const tagged = /^ {2}tags:\s*\[[^\]]*\borbit-build\b[^\]]*\]/mu.test(block) || /^ {2}tags:\s*\n(?: {4}- .*\n)*? {4}- orbit-build\b/mu.test(block);
    expect(extendsRunner || tagged, "needs the orbit-build tag").toBe(true);
    expect(/^ {2}tags:\s*\[[^\]]*\b(light|big)\b/mu.test(block), "must not sit on a shared lane").toBe(false);
  });

  it("starts on the nightly schedule (the one that sets ORBIT_NIGHTLY_BROWSERS)", () => {
    expect(jobVerdict(drillJob(), nightly)).toBe("run");
  });

  it.each(Object.entries(notNightly))("never starts on %s", (_label, env) => {
    expect(jobVerdict(drillJob(), env)).toBe("never");
  });

  it("is not allowed to fail, so a failed drill fails the nightly pipeline", () => {
    const block = blocks.get(drillJob());
    expect(/^ {2}allow_failure:\s*true\b/mu.test(block), "job-level allow_failure: true").toBe(false);
    expect(/^ {2}allow_failure:\s*\n {4}exit_codes:/mu.test(block), "exit_codes tolerance hides a failure").toBe(false);
    for (const rule of effectiveRules(drillJob(), ci, [STUB])) {
      expect(rule.allow_failure, "rule-level allow_failure").not.toBe("true");
    }
  });

  it("is in a stage before `maintenance`, so nightly_report files its failure like the other nightly checks", () => {
    const stage = /^ {2}stage:\s*(\S+)/mu.exec(blocks.get(drillJob()))?.[1];
    const stages = stagesOf(ci);
    expect(stages).toContain(stage);
    expect(stages.indexOf(stage)).toBeLessThan(stages.indexOf("maintenance"));
    expect(jobVerdict("nightly_report", nightly)).toBe("failure");
  });

  it("no longer lists test-backup-restore.sh as deliberately deferred in the .gitlab-ci.yml header", () => {
    const header = ci.split("\n").slice(0, ci.split("\n").findIndex((line) => !line.startsWith("#") && line.trim() !== "")).join("\n");
    const start = header.indexOf("deliberately deferred");
    expect(start).toBeGreaterThan(-1);
    const deferred = header.slice(start, header.indexOf("Every job that touches Docker"));
    expect(deferred).not.toMatch(/test-backup-restore\.sh/u);
  });

  it("says in the drill's own header which job runs it, and that it is nightly", () => {
    const header = drillScript.split("\n").filter((line) => line.startsWith("#")).slice(0, 60).join("\n");
    expect(header).toContain(drillJob());
    expect(header).toMatch(/nightly/iu);
  });
});
