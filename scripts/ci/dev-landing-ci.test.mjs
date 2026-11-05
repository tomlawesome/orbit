import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BATCH_EVENTS, OTHER_EVENTS, evaluate, pipelineOf, verdictOf } from "../test-support/ci-simulate.mjs";
import { effectiveRules, includesOf, jobBlock, jobNamesOf, readCi, ruleEntries } from "../test-support/gitlab-ci.mjs";

/*
 * #1737 (owner decision 2026-11-05): a push to `dev`, the landing push after a
 * merge request merges, starts a pipeline that runs only the fast checks,
 * `gitleaks` and `private-details`, each with `timeout: 5m`. Every other
 * event keeps the jobs it has today. The wiring is agent-infra's shared
 * dev-landing/v1 snippet, pinned to a commit.
 *
 * There is no separate name/history guard job: the private-details job is the
 * commit author/message/AI-credit check (#1562), so the fast set is two jobs.
 *
 * "Today" is fixtures/ci-pipelines-before-1737.json, captured from the
 * simulator (scripts/test-support/ci-simulate.mjs) at 6ab7d978, the commit
 * before this change.
 *
 * Simulator gap: ci-simulate.mjs's workflowOf() hard-codes the variables of
 * the back-merge template's two rules by position, so a third template rule
 * (the dev-landing one, first) shifts them, and it does not read the
 * dev-landing rule's variables. This file therefore resolves workflow:rules
 * itself; for every event other than a dev push it hands the simulator the
 * workflow without the dev-landing reference, i.e. the old shape.
 */
const COMMIT = "1dca70057bd93f68ded22c6b159f315c987c1663";
const TEMPLATE_FILE = "scripts/dev-landing/ci-template.yml";
const FIXTURE = "../test-support/fixtures/dev-landing-v1-ci-template.yml";
const ci = readCi();
const landing = readFileSync(new URL(FIXTURE, import.meta.url), "utf8");
const backmerge = readFileSync(new URL("../test-support/fixtures/backmerge-skip-v1-ci-template.yml", import.meta.url), "utf8");
const templates = [landing, backmerge];
const before = JSON.parse(readFileSync(new URL("../test-support/fixtures/ci-pipelines-before-1737.json", import.meta.url), "utf8"));

const FAST_SET = ["gitleaks", "private-details"];
const pushTo = (branch) => ({ CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: branch });
const EVENTS = { ...OTHER_EVENTS, ...BATCH_EVENTS, pushPrimary: pushTo("primary") };
const DEV_PUSH = pushTo("dev");

const isLandingRule = (rule) => typeof rule.if === "string" && rule.if.includes('"primary"') && rule.if.includes('"dev"');
const withoutLanding = (text) => text.replace(/^[ \t]*- !reference \[\.dev-landing, workflow_rules\][^\n]*\n/mu, "");

// The pipeline an event creates under the new workflow: the dev-landing rule
// is matched here (first, as the snippet's header requires); anything else is
// the simulator's, on the workflow as it was.
function landingVariables(env) {
  const rule = effectiveRules("workflow", ci, templates).find(isLandingRule);
  if (rule === undefined || !evaluate(rule.if, env)) return null;
  // The variables the template's rule sets (fixture: DEV_LANDING "true").
  return { DEV_LANDING: "true" };
}

function pipeline(env) {
  const rules = effectiveRules("workflow", ci, templates);
  const first = rules.find((rule) => rule.if === undefined || evaluate(rule.if, env));
  if (first !== undefined && isLandingRule(first)) {
    const full = { ...env, ...landingVariables(env) };
    const jobs = {};
    for (const name of jobNamesOf(ci)) {
      const verdict = verdictOf(effectiveRules(name, ci, templates), full);
      if (verdict !== "never") jobs[name] = verdict;
    }
    return { pipeline: true, jobs };
  }
  return pipelineOf(env, withoutLanding(ci), templates);
}

describe("the dev-landing template is wired in (#1737)", () => {
  it("is included at the pinned commit, with the tag on the same line", () => {
    const entry = includesOf(ci).find((include) => include.file === TEMPLATE_FILE);
    expect(entry, `no include of ${TEMPLATE_FILE}`).toBeDefined();
    expect(entry).toMatchObject({ project: "ai/agent-infra", ref: COMMIT, comment: "dev-landing/v1" });
    expect(entry.ref).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("keeps the private-details and back-merge includes", () => {
    const files = includesOf(ci).map((include) => include.file);
    expect(files).toContain("scripts/private-details/ci-template.yml");
    expect(files).toContain("scripts/backmerge-skip/ci-template.yml");
  });

  it("starts workflow:rules with the dev-landing reference (first match wins)", () => {
    const rules = effectiveRules("workflow", ci, templates);
    expect(rules[0]).toMatchObject({ if: expect.stringContaining('$CI_COMMIT_BRANCH == "dev"') });
    expect(isLandingRule(rules[0])).toBe(true);
    expect(ruleEntries("workflow", ci)[0]).toEqual({ reference: [".dev-landing", "workflow_rules"] });
  });

  it("starts the rules of gitleaks and private-details with !reference [.dev-landing-check, rules]", () => {
    for (const name of FAST_SET) {
      const first = ruleEntries(name, ci)[0];
      expect(first?.reference?.join(","), name).toBe(".dev-landing-check,rules");
    }
  });

  it("starts the rules of every job outside the fast set with the dev-landing job rule as the first entry", () => {
    const others = jobNamesOf(ci).filter((name) => !FAST_SET.includes(name) && !jobNamesOf(landing).includes(name) && name !== "backmerge-check");
    expect(others.length).toBeGreaterThan(30);
    const wrong = others.filter((name) => {
      const first = ruleEntries(name, ci)[0];
      return !(first && Array.isArray(first.reference) && first.reference.join(",") === ".dev-landing,job_rule");
    });
    expect(wrong, "jobs that would run on the landing push").toEqual([]);
  });
});

describe("a push to dev (#1737)", () => {
  it("creates a pipeline", () => {
    expect(pipeline(DEV_PUSH).pipeline).toBe(true);
  });

  it("runs exactly gitleaks and private-details, automatically", () => {
    const { jobs } = pipeline(DEV_PUSH);
    expect(Object.keys(jobs ?? {}).sort()).toEqual(FAST_SET);
    for (const name of FAST_SET) expect(jobs[name], name).toBe("run");
  });

  it("gives each fast check a 5 minute timeout (own `timeout: 5m` or extends .dev-landing-check)", () => {
    for (const name of FAST_SET) {
      const block = jobBlock(name, ci);
      const own = /^ {2}timeout:\s*(\S+)/mu.exec(block)?.[1];
      const extended = /^ {2}extends:\s*(?:\[?\s*)?.*\.dev-landing-check/mu.test(block);
      const timeout = own ?? (extended ? "5m" : undefined);
      expect(timeout, `${name} timeout`).toBe("5m");
    }
  });

  it("keeps the fast checks free of needs on skipped jobs", () => {
    for (const name of FAST_SET) expect(jobBlock(name, ci), name).toMatch(/^ {2}needs: \[\]\s*$/mu);
  });
});

describe("DEV_LANDING is set by a push to dev alone (#1737)", () => {
  it("is set on a push to dev", () => {
    expect(landingVariables(DEV_PUSH)).toEqual({ DEV_LANDING: "true" });
  });

  for (const [event, env] of Object.entries(EVENTS)) {
    if (event === "pushDev" || event === "pushPrimary") continue;
    it(`is not set for ${event}`, () => {
      expect(landingVariables(env)).toBeNull();
    });
  }
});

describe("every other pipeline is as it was at 6ab7d978 (#1737)", () => {
  it("the fixture covers every simulated event", () => {
    expect(Object.keys(before).sort()).toEqual(Object.keys(EVENTS).sort());
  });

  for (const [event, env] of Object.entries(EVENTS)) {
    if (event === "pushDev" || event === "pushPrimary") continue;
    it(`${event}: same pipeline, same jobs, same verdicts`, () => {
      expect(pipeline(env)).toEqual(before[event]);
    });
  }

  it("pushDev: started no pipeline before; this is the change", () => {
    expect(before.pushDev).toEqual({ pipeline: false });
  });

  it("a push to primary gets the same fast-only result as a push to dev (the template matches both)", () => {
    expect(pipeline(pushTo("primary"))).toEqual(pipeline(DEV_PUSH));
    expect(Object.keys(pipeline(pushTo("primary")).jobs ?? {}).sort()).toEqual(FAST_SET);
  });
});

describe("the pinned copy of the template (#1737)", () => {
  it("defines what Orbit's references need", () => {
    expect(landing).toMatch(/^\.dev-landing:\n {2}workflow_rules:/mu);
    expect(landing).toMatch(/DEV_LANDING: "true"/u);
    expect(landing).toMatch(/^\.dev-landing-check:\n {2}timeout: 5m/mu);
  });

  it("matches the pinned include ref: the fixture is the template at that commit", () => {
    const entry = includesOf(ci).find((include) => include.file === TEMPLATE_FILE);
    expect(entry?.ref, "the include's ref").toBe(COMMIT);
    const repo = join(homedir(), "projects", "agent-infra");
    if (!existsSync(repo)) return;
    let upstream;
    try {
      upstream = execFileSync("git", ["-C", repo, "show", `${entry.ref}:${TEMPLATE_FILE}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return;
    }
    expect(upstream).toBe(landing);
  });
});
