import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { effectiveRules, includesOf, jobNamesOf, readCi, ruleEntries, stagesOf } from "../test-support/gitlab-ci.mjs";

/*
 * #1698 (owner decisions 66a, 70a): Orbit adopts agent-infra's shared
 * back-merge skip. A back-merge MR (preview into dev, main into preview) that
 * changes no file runs only `backmerge-check`; every other pipeline is as before.
 *
 * The template comes from another repo. These tests read a pinned copy of it
 * at scripts/test-support/fixtures/backmerge-skip-v1-ci-template.yml (the
 * commit below is the tag's, so the content cannot move); the last test
 * checks the copy's recorded blob id, and compares it with the agent-infra
 * checkout when that exists.
 */
const COMMIT = "f950d7d9abc28838e6d1353da8c9663f9ecb27b7";
// The git blob id of TEMPLATE_FILE at each pinned commit (`git -C <agent-infra>
// rev-parse <commit>:<file>`). The fixture must hash to the entry for the
// include's ref, so a ref bump without a new entry and a refreshed fixture
// fails everywhere, not only where agent-infra is checked out (FR-5, #1784).
const TEMPLATE_BLOB_AT = { "f950d7d9abc28838e6d1353da8c9663f9ecb27b7": "663f4ce694b379102212a83ad9760b15509739b4" };
const TEMPLATE_FILE = "scripts/backmerge-skip/ci-template.yml";
const template = readFileSync(new URL("../test-support/fixtures/backmerge-skip-v1-ci-template.yml", import.meta.url), "utf8");
const ci = readCi();
const FAST_CHECKS = ["gitleaks", "private-details"];
const templates = [template, readFileSync(new URL("../test-support/fixtures/dev-landing-v1-ci-template.yml", import.meta.url), "utf8")];
// Orbit's own jobs. A block that only overrides the template's job (the
// backmerge-check image pin, S-ci-1) is the template's job, not Orbit's.
const templateJobs = new Set(jobNamesOf(template));
const orbitJobs = () => jobNamesOf(ci).filter((name) => !templateJobs.has(name));

const JOB_RULE = [{ if: '$BACKMERGE_EMPTY == "true"', when: "never" }];

describe("Orbit includes the back-merge skip template (#1698)", () => {
  it("names the template file at the tag's commit, with the tag on the same line", () => {
    const entry = includesOf(ci).find((include) => include.file === TEMPLATE_FILE);
    expect(entry, `no include of ${TEMPLATE_FILE}`).toBeDefined();
    expect(entry).toMatchObject({ project: "ai/agent-infra", ref: COMMIT, comment: "backmerge-skip/v1" });
    expect(entry.ref, "a commit, not the tag").toMatch(/^[0-9a-f]{40}$/u);
  });

  it("keeps the private-details include beside it", () => {
    expect(includesOf(ci).some((include) => include.file === "scripts/private-details/ci-template.yml")).toBe(true);
  });

  it("includes `test` in stages, where it changes no existing job's order", () => {
    const stages = stagesOf(ci);
    expect(stages).toContain("test");
    expect(stages.filter((stage) => stage !== "test")).toEqual(["classify", "fast", "policy", "acceptance", "publish", "maintenance"]);
  });

  it("starts workflow:rules with the template's two back-merge rules, before Orbit's own", () => {
    // The dev-landing reference (#1737) is first; the back-merge rules follow it.
    const all = ruleEntries("workflow", ci);
    expect(all[0]).toEqual({ reference: [".dev-landing", "workflow_rules"] });
    const entries = all.slice(1);
    expect(entries[0]).toEqual({ reference: [".backmerge-skip", "workflow_rules"] });
    expect(entries.slice(1).some((entry) => entry.reference), "only the first entry is a !reference").toBe(false);
    const rules = effectiveRules("workflow", ci, templates).slice(1);
    expect(rules[0].variables, "the first template rule sets the variable").toBeDefined();
    expect(rules[0].if).toMatch(/BACKMERGE|CI_MERGE_REQUEST_SOURCE_BRANCH_NAME/u);
    // Orbit's own first rule (tags publish nothing) follows the template's two.
    expect(rules[2]).toEqual({ if: "$CI_COMMIT_TAG", when: "never" });
  });
});

describe("every Orbit job starts with the back-merge job rule (#1698)", () => {
  const names = orbitJobs();

  it("finds the jobs, and not the template's job or hidden keys", () => {
    expect(names.length).toBeGreaterThan(30);
    expect(names).toContain("rig_webkit");
    expect(names).not.toContain("backmerge-check");
    expect(names.some((name) => name.startsWith("."))).toBe(false);
  });

  it("has the job rule as the first effective rule of each, after anchors and !references are expanded", () => {
    const wrong = names.filter((name) => {
      const rules = effectiveRules(name, ci, templates);
      // The two fast checks run on the landing push, so they start with its check rule instead.
      const landing = FAST_CHECKS.includes(name) ? { if: '$DEV_LANDING == "true"' } : { if: '$DEV_LANDING == "true"', when: "never" };
      expect(rules[0], `${name}: the dev-landing rule is first`).toEqual(landing);
      const first = rules[1];
      return !(first && first.if === JOB_RULE[0].if && first.when === JOB_RULE[0].when);
    });
    expect(wrong, "jobs whose first rule is not `!reference [.backmerge-skip, job_rule]`").toEqual([]);
  });

  it("writes it as the !reference tag at the head of the job's own list or its anchored list", () => {
    const loose = names.filter((name) => {
      const entries = ruleEntries(name, ci);
      const landingRef = FAST_CHECKS.includes(name) ? [".dev-landing-check", "rules"] : [".dev-landing", "job_rule"];
      expect(entries[0], `${name}: the dev-landing reference is first`).toEqual({ reference: landingRef });
      const first = entries[1];
      return !(first && Array.isArray(first.reference) && first.reference.join(",") === ".backmerge-skip,job_rule");
    });
    expect(loose, "jobs whose rules list does not begin with the !reference").toEqual([]);
  });

  it("still gives each job at least one rule after it: the job's own behaviour", () => {
    for (const name of names) {
      expect(effectiveRules(name, ci, templates).length, name).toBeGreaterThan(1);
    }
  });
});

// The rule subset Orbit uses (==, !=, =~, &&, ||, parentheses, bare variables),
// as in gitlab-ci-lanes.test.mjs; a `changes:` condition is not evaluated.
function evaluate(expression, env) {
  const value = (name) => {
    const found = env[name];
    return found === undefined || found === "" ? null : found;
  };
  const match = (subject, pattern, negate) => {
    const hit = subject !== null && pattern.test(subject);
    return negate ? !hit : hit;
  };
  const source = expression
    .replace(
      /\$([A-Z][A-Z0-9_]*)\s*(=~|!~)\s*\/((?:\\\/|[^/])*)\//gu,
      (_all, name, operator, pattern) => `match(value("${name}"), new RegExp(${JSON.stringify(pattern.replace(/\\\//gu, "/"))}, "u"), ${operator === "!~"})`,
    )
    .replace(/\$([A-Z][A-Z0-9_]*)/gu, (_all, name) => `value("${name}")`);
  return Boolean(new Function("value", "match", `return (${source});`)(value, match));
}

function verdictOf(rules, env) {
  if (rules.length === 0) return "run"; // a job with no rules starts
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

const isJobRule = (rule) => rule.if === JOB_RULE[0].if && rule.when === JOB_RULE[0].when;

describe("a simulated back-merge merge request (#1698)", () => {
  const names = orbitJobs();
  const backMerge = {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "preview",
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev",
  };
  const events = {
    backMergeMainIntoPreview: { ...backMerge, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "main", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview" },
    devMergeRequest: { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "feature/x", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev" },
    promotionMergeRequest: { CI_PIPELINE_SOURCE: "merge_request_event", CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "dev", CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview" },
    devPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "dev" },
    previewPush: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: "preview" },
    nightly: { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ORBIT_NIGHTLY_BROWSERS: "true" },
  };

  it("creates no Orbit job when the template says the diff is empty (BACKMERGE_EMPTY=true)", () => {
    for (const environment of [backMerge, events.backMergeMainIntoPreview]) {
      const started = names.filter((name) => verdictOf(effectiveRules(name, ci, templates), { ...environment, BACKMERGE_EMPTY: "true" }) !== "never");
      expect(started).toEqual([]);
    }
  });

  it("creates the same jobs as without the skip when BACKMERGE_EMPTY=false, and on every other event", () => {
    // Each job's rules are worked out once, not once per event and setting:
    // recomputing them in the inner loop took this test to the 5 s limit
    // on a loaded host (docs/flakes.md, three sightings).
    const rulesOf = new Map(names.map((name) => {
      const rules = effectiveRules(name, ci, templates);
      return [name, { rules, before: rules.filter((rule) => !isJobRule(rule)) }];
    }));
    for (const [event, environment] of Object.entries({ backMerge, ...events })) {
      for (const empty of ["false", undefined]) {
        const env = empty === undefined ? environment : { ...environment, BACKMERGE_EMPTY: empty };
        for (const name of names) {
          const { rules, before } = rulesOf.get(name);
          expect(verdictOf(rules, env), `${name} on ${event} with BACKMERGE_EMPTY=${empty}`).toBe(verdictOf(before, env));
        }
      }
    }
  });

  it("leaves a push pipeline alone: the variable is unset there", () => {
    // The variable is set by workflow:rules for back-merges alone; on a push
    // it is unset, and the job rule must not match.
    for (const name of names) {
      expect(verdictOf(effectiveRules(name, ci, templates), events.devPush), name).toBe(
        verdictOf(effectiveRules(name, ci, templates).filter((rule) => !isJobRule(rule)), events.devPush),
      );
    }
  });
});

describe("docs/releasing.md after adopting the back-merge skip (#1698)", () => {
  const doc = readFileSync(new URL("../../docs/releasing.md", import.meta.url), "utf8");

  it("no longer says to skip the back-merge after an ordinary promotion", () => {
    expect(doc).not.toMatch(/No back-merge of `preview` into `dev` after an ordinary promotion/u);
    expect(doc).not.toMatch(/each back-merge costs a full pipeline/u);
  });

  it("says to back-merge after every promotion, and that an empty one runs only backmerge-check", () => {
    const flat = doc.replace(/\s+/gu, " ");
    expect(flat).toMatch(/after every promotion, back-merge/iu);
    expect(flat).toMatch(/`preview` into `dev`/u);
    expect(flat).toMatch(/`main` into `preview`/u);
    expect(flat).toMatch(/empty back-merge (MR|merge request) runs only `backmerge-check`/iu);
    expect(flat).toMatch(/#1698/u);
  });
});

describe("the pinned copy of the template", () => {
  it("defines what Orbit's references need: two workflow rules, the job rule, and backmerge-check in stage test", () => {
    expect(effectiveRules("workflow", "workflow:\n  rules:\n    - !reference [.backmerge-skip, workflow_rules]\n", templates)).toHaveLength(2);
    expect(template).toMatch(/^backmerge-check:\n {2}stage: test\b/mu);
    expect(template).toMatch(/\$BACKMERGE_EMPTY == "true"\n {6}when: never/u);
  });

  it("matches the tag in the agent-infra checkout, when there is one", () => {
    const entry = includesOf(ci).find((include) => include.file === TEMPLATE_FILE);
    expect(entry?.ref, "the include's ref").toBe(COMMIT);
    const blob = TEMPLATE_BLOB_AT[entry.ref];
    expect(blob, `no recorded template blob for ref ${entry.ref}`).toMatch(/^[0-9a-f]{40}$/u);
    const fixtureBlob = execFileSync("git", ["hash-object", "--stdin"], { input: template, encoding: "utf8" }).trim();
    expect(fixtureBlob, "the fixture's blob id").toBe(blob);
    const repo = join(homedir(), "projects", "agent-infra");
    if (!existsSync(repo)) return; // the recorded blob above is the check here
    let upstream;
    try {
      upstream = execFileSync("git", ["-C", repo, "show", `${COMMIT}:${TEMPLATE_FILE}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return; // checkout without that commit: the recorded blob above is the check
    }
    expect(upstream).toBe(template);
  });
});
