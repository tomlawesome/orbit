// Simulates which pipeline GitLab creates for an event, from the rules in
// .gitlab-ci.yml and its included templates (#1720). The rule subset Orbit
// uses (==, !=, =~, !~, &&, ||, parentheses, bare variables), as in
// backmerge-skip-adoption.test.mjs. A `changes:` condition counts as matched:
// every simulated event changes files, except where the event says otherwise
// with EMPTY_DIFF (the back-merge skip's empty case).
import { effectiveRules, jobBlock, jobNamesOf } from "./gitlab-ci.mjs";

export function evaluate(expression, env) {
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

const matches = (rule, env) => (rule.if === undefined || evaluate(rule.if, env)) && !(rule.changes && env.EMPTY_DIFF === "true");

// The `variables:` of each inline rule in Orbit's workflow, in order. The
// shared parser keeps no nested maps, so this reads the block itself.
function inlineWorkflowVariables(text) {
  const lines = jobBlock("workflow", text).split("\n");
  const start = lines.findIndex((line) => /^ {2}rules:/u.test(line));
  const out = [];
  let current = null;
  let inVariables = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/u.test(line)) continue;
    if (/^ {2}\S/u.test(line)) break;
    if (/^ {4}- /u.test(line)) {
      inVariables = false;
      if (/^ {4}- !reference/u.test(line)) continue;
      current = {};
      out.push(current);
      if (/^ {4}- variables:/u.test(line)) inVariables = true;
      continue;
    }
    if (/^ {6}variables:\s*$/u.test(line)) {
      inVariables = true;
      continue;
    }
    if (/^ {6}\S/u.test(line)) {
      inVariables = false;
      continue;
    }
    const pair = /^ {8}([A-Z][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*(#.*)?$/u.exec(line);
    if (inVariables && pair && current) current[pair[1]] = pair[2];
  }
  return out;
}

// The pipeline an event creates: null when workflow:rules refuses it, else
// the variables the matching workflow rule sets.
export function workflowOf(env, text, templates) {
  const rules = effectiveRules("workflow", text, templates);
  const templateCount = rules.length - inlineWorkflowVariables(text).length;
  const inline = inlineWorkflowVariables(text);
  // The back-merge template's two rules: the first (files changed) sets
  // BACKMERGE_EMPTY=false, the second (no change) sets it to true.
  const templateVariables = [{ BACKMERGE_EMPTY: "false" }, { BACKMERGE_EMPTY: "true" }];
  for (const [index, rule] of rules.entries()) {
    if (!matches(rule, env)) continue;
    if ((rule.when ?? "always") === "never") return null;
    return index < templateCount ? (templateVariables[index] ?? {}) : inline[index - templateCount];
  }
  return null;
}

export function verdictOf(rules, env) {
  if (rules.length === 0) return "run";
  for (const rule of rules) {
    if (!matches(rule, env)) continue;
    const when = rule.when ?? "on_success";
    if (when === "never") return "never";
    if (when === "manual") return "manual";
    if (when === "on_failure") return "failure";
    return "run";
  }
  return "never";
}

// { pipeline: false } or { pipeline: true, jobs: { name: verdict } } with
// only the jobs that are created (verdict other than never).
export function pipelineOf(env, text, templates) {
  const variables = workflowOf(env, text, templates);
  if (variables === null) return { pipeline: false };
  const full = { ...env, ...variables };
  const jobs = {};
  for (const name of jobNamesOf(text)) {
    const verdict = verdictOf(effectiveRules(name, text, templates), full);
    if (verdict !== "never") jobs[name] = verdict;
  }
  return { pipeline: true, jobs };
}

const mr = (source, target, extra = {}) => ({
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: source,
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: target,
  ...extra,
});
const push = (branch) => ({ CI_PIPELINE_SOURCE: "push", CI_COMMIT_BRANCH: branch });
const schedule = (variable) => ({ CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", [variable]: "true" });

// Every event other than a merge request into a batch branch. Their pipelines
// must stay as they were before #1720 (fixtures/ci-pipelines-before-1720.json).
export const OTHER_EVENTS = {
  mrIntoDev: mr("feature/x", "dev"),
  mrIntoDevAcceptanceLabel: mr("feature/x", "dev", { CI_MERGE_REQUEST_LABELS: "ci: acceptance" }),
  mrFromBatchIntoDev: mr("batch-a", "dev"),
  mrFromBatchBIntoDev: mr("batch-b", "dev"),
  mrIntoPreview: mr("dev", "preview"),
  mrIntoMain: mr("preview", "main"),
  mrIntoHotfix: mr("fix/y", "hotfix/1.2.3"),
  mrIntoBatchLookalike: mr("feature/x", "batch-c"),
  mrIntoBatchPrefix: mr("feature/x", "batch-a-old"),
  backMergePreviewIntoDev: mr("preview", "dev"),
  backMergePreviewIntoDevEmpty: mr("preview", "dev", { EMPTY_DIFF: "true" }),
  backMergeMainIntoPreview: mr("main", "preview"),
  backMergeMainIntoPreviewEmpty: mr("main", "preview", { EMPTY_DIFF: "true" }),
  pushDev: push("dev"),
  pushPreview: push("preview"),
  pushMain: push("main"),
  pushHotfix: push("hotfix/1.2.3"),
  pushBatchA: push("batch-a"),
  pushWorkingBranch: push("feature/x"),
  apiOnWorkingBranch: { CI_PIPELINE_SOURCE: "api", CI_COMMIT_BRANCH: "feature/x" },
  webOnDev: { CI_PIPELINE_SOURCE: "web", CI_COMMIT_BRANCH: "dev" },
  scheduleRenovate: schedule("RENOVATE"),
  scheduleSidecarFreshness: schedule("SIDECAR_FRESHNESS"),
  scheduleInstallBootstrap: schedule("INSTALL_BOOTSTRAP"),
  scheduleBaseImageRepin: schedule("BASE_IMAGE_REPIN"),
  scheduleTidyFreshness: schedule("TIDY_FRESHNESS"),
  scheduleDoorImport: schedule("DOOR_IMPORT"),
  scheduleNightlyBrowsers: schedule("ORBIT_NIGHTLY_BROWSERS"),
  scheduleWithoutVariable: { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev" },
  tag: { CI_PIPELINE_SOURCE: "push", CI_COMMIT_TAG: "v1.2.3" },
};

export const BATCH_EVENTS = {
  mrIntoBatchA: mr("feature/x", "batch-a"),
  mrIntoBatchB: mr("feature/x", "batch-b"),
  mrIntoBatchALabelled: mr("feature/x", "batch-a", { CI_MERGE_REQUEST_LABELS: "ci: acceptance" }),
  mrFromDevIntoBatchA: mr("dev", "batch-a"),
};
