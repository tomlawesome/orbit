import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1720: a merge request into `batch-a` or `batch-b` runs only the static
 * checks; every other pipeline is unchanged.
 *
 * Written from the issue text alone. GitLab is the evaluator: the project CI
 * lint API resolves the includes, anchors and `!reference`s and returns the
 * merged YAML (`include_merged_yaml`). A small expression evaluator then
 * replays workflow:rules and each job's rules for chosen pipeline events.
 * The lint API cannot simulate a merge-request pipeline itself (dry_run
 * simulates a push), hence the replay.
 *
 * Env: ORBIT_CI_FILE   file under test (default .gitlab-ci.yml)
 *      ORBIT_CI_BASELINE_REF  commit whose file is "before" (default ecee2eb7)
 *      ORBIT_LINT_REF  ref the lint call names (default dev)
 *      ORBIT_SKIP_GITLAB_LINT=1  skip everything here (no GitLab access)
 */
/* Local only: it calls GitLab's lint API and reads ecee2eb7 with `git show`,
   neither of which a CI job has (a shallow clone, no `gl`). CI's own proof is
   scripts/ci/batch-intake-ci.test.mjs. */
const SKIP = process.env.ORBIT_SKIP_GITLAB_LINT === "1" || process.env.CI === "true";
const ROOT = new URL("../../", import.meta.url).pathname;
const FILE = process.env.ORBIT_CI_FILE ?? join(ROOT, ".gitlab-ci.yml");
const BASELINE_REF = process.env.ORBIT_CI_BASELINE_REF ?? "ecee2eb7";
const LINT_REF = process.env.ORBIT_LINT_REF ?? "dev";
const STATIC_JOBS = ["gitleaks", "private-details", "flake_check", "backmerge-check"];

function loadYaml() {
  const dir = join(ROOT, "node_modules/.pnpm");
  const found = existsSync(dir) ? readdirSync(dir).find((d) => d.startsWith("yaml@")) : undefined;
  if (!found) throw new Error("no yaml package in node_modules/.pnpm");
  return createRequire(join(dir, found, "node_modules/")).call(null, join(dir, found, "node_modules/yaml"));
}

function mergedYaml(content, dir) {
  const out = execFileSync(
    "gl",
    ["api", `projects/49/ci/lint?dry_run=true&include_merged_yaml=true&ref=${LINT_REF}`, "-X", "POST", "-F", `content=@${content}`],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const body = JSON.parse(out);
  // A push to the ref may legitimately create no pipeline; any other error is a real one.
  const real = (body.errors ?? []).filter((e) => !/did not run/.test(e));
  if (real.length > 0 || !body.merged_yaml) throw new Error(`lint refused: ${JSON.stringify(body.errors)}`);
  return loadYaml().parse(body.merged_yaml);
}

// ---- GitLab rules:if expression evaluator (the subset Orbit uses) ----
function tokenize(src) {
  const re = /\s*(&&|\|\||==|!=|=~|!~|\(|\)|\$[A-Za-z_][A-Za-z0-9_]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)*\/[a-z]*|null)/y;
  const out = [];
  let i = 0;
  while (i < src.trim().length + (src.length - src.trimStart().length)) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) { if (src.slice(i).trim() === "") break; throw new Error(`cannot tokenize ${src} at ${i}`); }
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}
function evaluate(expr, env) {
  const t = tokenize(expr);
  let p = 0;
  const val = (tok) => {
    if (tok === "null") return null;
    if (tok[0] === "$") { const v = env[tok.slice(1)]; return v === undefined || v === "" ? null : v; }
    if (tok[0] === '"' || tok[0] === "'") return tok.slice(1, -1);
    const k = tok.lastIndexOf("/");
    return new RegExp(tok.slice(1, k), tok.slice(k + 1));
  };
  function primary() {
    if (t[p] === "(") { p++; const v = or(); p++; return v; }
    const left = val(t[p++]);
    const op = t[p];
    if (["==", "!=", "=~", "!~"].includes(op)) {
      p++;
      const right = val(t[p++]);
      if (op === "==") return left === right;
      if (op === "!=") return left !== right;
      const hit = left !== null && right.test(left);
      return op === "=~" ? hit : !hit;
    }
    return left !== null;
  }
  function and() { let v = primary(); while (t[p] === "&&") { p++; const r = primary(); v = v && r; } return v; }
  function or() { let v = and(); while (t[p] === "||") { p++; const r = and(); v = v || r; } return v; }
  const result = or();
  if (p !== t.length) throw new Error(`trailing tokens in ${expr}`);
  return result;
}

const flat = (rules) => (rules ?? []).flat(Infinity);
// `changes`/`exists` cannot be replayed; both file versions are treated alike.
const matches = (rule, env) => (rule.if === undefined ? true : evaluate(String(rule.if), env));

function workflowEnv(ci, env) {
  const rules = flat(ci.workflow?.rules);
  const out = { ...env };
  for (const rule of rules) {
    if (!matches(rule, out)) continue;
    if (rule.when === "never") return null;
    Object.assign(out, rule.variables ?? {});
    return out;
  }
  return null;
}
const isJob = (name, def) => !name.startsWith(".") && def && typeof def === "object" && ("script" in def || "trigger" in def);
function jobsIn(ci, env) {
  const wf = workflowEnv(ci, env);
  if (wf === null) return null;
  const names = [];
  for (const [name, def] of Object.entries(ci)) {
    if (!isJob(name, def)) continue;
    const rules = flat(def.rules);
    if (rules.length === 0) { names.push(name); continue; }
    const hit = rules.find((r) => matches(r, wf));
    if (hit && hit.when !== "never") names.push(name);
  }
  return { env: wf, jobs: names.sort() };
}

const mr = (source, target) => ({
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: source,
  CI_MERGE_REQUEST_TARGET_BRANCH_NAME: target,
  CI_COMMIT_BRANCH: undefined,
  CI_MERGE_REQUEST_LABELS: "",
});
const push = (branch, open = false) => ({
  CI_PIPELINE_SOURCE: "push",
  CI_COMMIT_BRANCH: branch,
  ...(open ? { CI_OPEN_MERGE_REQUESTS: "orbit!1" } : {}),
});

const BATCH_MRS = [
  ["feature into batch-a", mr("feat/x", "batch-a")],
  ["feature into batch-b", mr("feat/x", "batch-b")],
  ["batch fix into batch-a", mr("fix/1", "batch-a")],
];
const OTHER_EVENTS = [
  ["MR into dev", mr("feat/x", "dev")],
  ["MR into preview", mr("feat/x", "preview")],
  ["MR into main", mr("feat/x", "main")],
  ["MR into a hotfix branch", mr("fix/x", "hotfix/1.2")],
  ["MR from batch-a into dev", mr("batch-a", "dev")],
  ["MR from batch-b into dev", mr("batch-b", "dev")],
  ["MR into batch-c", mr("feat/x", "batch-c")],
  ["MR into batch-ab", mr("feat/x", "batch-ab")],
  ["MR into xbatch-a", mr("feat/x", "xbatch-a")],
  ["MR into batch-a2", mr("feat/x", "batch-a2")],
  ["MR into a feature branch", mr("feat/y", "feat/x")],
  ["back-merge preview into dev", mr("preview", "dev")],
  ["back-merge main into preview", mr("main", "preview")],
  ["push to dev", push("dev")],
  ["push to preview", push("preview")],
  ["push to main", push("main")],
  ["push to a hotfix branch", push("hotfix/1.2")],
  ["push to batch-a", push("batch-a")],
  ["push to a feature branch", push("feat/x")],
  ["push to a feature branch with an open MR", push("feat/x", true)],
  ["manual (api) pipeline on a branch", { CI_PIPELINE_SOURCE: "api", CI_COMMIT_BRANCH: "feat/x" }],
  ["tag pipeline", { CI_PIPELINE_SOURCE: "push", CI_COMMIT_TAG: "v1.0.0" }],
  ["plain schedule", { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev" }],
  ["renovate schedule", { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", RENOVATE: "true" }],
  ["nightly browser schedule", { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", ORBIT_NIGHTLY_BROWSERS: "true" }],
  ["tidy-freshness schedule", { CI_PIPELINE_SOURCE: "schedule", CI_COMMIT_BRANCH: "dev", TIDY_FRESHNESS: "true" }],
];

describe.skipIf(SKIP)("#1720 merge requests into a batch run only the static checks", () => {
  const after = mergedYaml(FILE, ROOT);
  let before;
  try {
    const old = execFileSync("git", ["show", `${BASELINE_REF}:.gitlab-ci.yml`], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const tmp = join(process.env.TMPDIR ?? "/tmp", `batch-intake-spec-baseline-${process.pid}.yml`);
    execFileSync("sh", ["-c", `cat > "${tmp}"`], { input: old });
    before = mergedYaml(tmp, ROOT);
  } catch (error) {
    before = null;
    console.warn(`baseline ${BASELINE_REF} unavailable: ${error.message}`);
  }
  const allJobs = Object.entries(after).filter(([n, d]) => isJob(n, d)).map(([n]) => n);

  it("sanity: the merged file has the four static jobs and many heavy ones", () => {
    for (const name of STATIC_JOBS) expect(allJobs).toContain(name);
    expect(allJobs.length).toBeGreaterThan(20);
  });

  for (const [label, env] of BATCH_MRS) {
    describe(label, () => {
      it("gets a pipeline marked as batch intake", () => {
        const run = jobsIn(after, env);
        expect(run, "workflow:rules must still create a pipeline").not.toBeNull();
        expect(run.env.BATCH_INTAKE).toBe("true");
      });
      it("runs the secret scan, private details and flake check, and nothing outside the static set", () => {
        const { jobs } = jobsIn(after, env);
        for (const name of ["gitleaks", "private-details", "flake_check"]) expect(jobs).toContain(name);
        expect(jobs.filter((j) => !STATIC_JOBS.includes(j))).toEqual([]);
      });
    });
  }

  it("every job other than the static ones has a BATCH_INTAKE `when: never` rule before any rule that could add it", () => {
    const bad = [];
    for (const name of allJobs) {
      if (STATIC_JOBS.includes(name)) continue;
      const rules = flat(after[name].rules);
      const stop = rules.findIndex((r) => r.when === "never" && /\$BATCH_INTAKE\s*==\s*"true"/.test(String(r.if ?? "")));
      const firstAdd = rules.findIndex((r) => r.when !== "never");
      if (stop === -1 || (firstAdd !== -1 && firstAdd < stop)) bad.push(name);
    }
    expect(bad).toEqual([]);
  });

  it("workflow:rules set BATCH_INTAKE only for a merge request whose target is batch-a or batch-b", () => {
    const setters = flat(after.workflow.rules).filter((r) => r.variables && "BATCH_INTAKE" in r.variables);
    expect(setters.length).toBeGreaterThan(0);
    for (const rule of setters) {
      expect(rule.variables.BATCH_INTAKE).toBe("true");
      expect(rule.when ?? "on_success").not.toBe("never");
    }
    for (const [label, env] of [...BATCH_MRS, ...OTHER_EVENTS]) {
      const run = jobsIn(after, env);
      const isBatch = BATCH_MRS.some(([l]) => l === label);
      expect(run?.env.BATCH_INTAKE === "true", label).toBe(isBatch);
    }
  });

  describe("every other event still gets exactly the jobs it got before", () => {
    for (const [label, env] of OTHER_EVENTS) {
      it(label, () => {
        if (before === null) throw new Error("baseline unavailable");
        expect(jobsIn(after, env)?.jobs ?? null).toEqual(jobsIn(before, env)?.jobs ?? null);
      });
    }
    it("a full pipeline (many jobs) is still created for an MR into dev", () => {
      expect(jobsIn(after, mr("feat/x", "dev")).jobs.length).toBeGreaterThan(10);
    });
  });
});
