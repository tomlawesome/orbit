#!/usr/bin/env node
/*
 * Whether the upgrade cells need to run on this pipeline (#1665, owner answer
 * 60a). The same shape as the reuse lookup (ADR-0028): skip only when a passing
 * run already covers the commit's content, and run on any doubt.
 *
 *   classify      node scripts/ci/upgrade-cells-gate.mjs .orbit-upgrade/gate.env
 *
 * It writes UPGRADE_CELLS=run|skip to that file, and on a skip also
 * UPGRADE_CELLS_SINCE=<sha>, the commit of the real run the skip stands on.
 * classify keeps the file as an artefact, so later pipelines can read it, and
 * a chain of skips always leads back to a pipeline that really ran.
 *
 * The cells run unless this is a merge-request pipeline into `preview`, none of
 * the reuse lookup's escape hatches is pulled (no ORBIT_REUSE_TOKEN, the label
 * `ci: rerun`, ORBIT_REUSE=off) and the merge request's newest passed pipeline
 * is a base from which nothing an update depends on has changed.
 *
 * Nothing here may fail the job that calls it: any API, parse or git error is
 * logged and read as "run". The token is sent as a header, never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

import { MAX_PIPELINES, labelled, parseEnvFile } from "./reuse-lookup.mjs";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 1024 * 1024;
const MAX_JOB_PAGES = 20;
const SHA = /^[0-9a-f]{40}$/u;

/* The paths an update depends on (owner 60a), as tests on a repository path. */
const INSTALLER_SCRIPTS = new Set([
  "scripts/install.sh",
  "scripts/installer-ui.sh",
  "scripts/configure.sh",
  "scripts/repair.sh",
  "scripts/get-orbit.sh",
  "scripts/update-and-start.sh",
  "scripts/container-entrypoint.sh",
]);

export function updateRelevant(path) {
  return INSTALLER_SCRIPTS.has(path)
    || /^docker-compose[^/]*\.yml$/u.test(path)
    || path.startsWith("compose/")
    || path.startsWith("drizzle/")
    || path === ".env-orbit.example"
    || path.startsWith("config/")
    /* a pattern, not a quoted prefix: the CI input scan (job-inputs.mjs)
       reads a bare "scripts/ci/..." string in code as a file it must hash */
    || /^scripts\/ci\/upgrade-/u.test(path)
    || path === "scripts/ci/write-test-manifest.sh";
}

/* A finished pipeline: later cells of an unfinished one may not exist yet. */
const UNFINISHED = new Set(["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"]);

async function request(url, { token, fetchImpl }, parse) {
  const response = await fetchImpl(url, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`${url} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const body = await response.text();
  if (body.length > MAX_BODY_CHARS) throw new Error(`${url} answered with a body over ${MAX_BODY_CHARS} characters`);
  return parse(body, response);
}

const parseJson = (body) => JSON.parse(body);

/* Every page of a listing, following x-next-page. */
async function requestAllPages(url, options) {
  const all = [];
  let page = "1";
  for (let count = 0; page; count += 1) {
    if (count >= MAX_JOB_PAGES) throw new Error(`${url} has more than ${MAX_JOB_PAGES} pages`);
    const separator = url.includes("?") ? "&" : "?";
    const { items, next } = await request(`${url}${separator}page=${encodeURIComponent(page)}`, options, (body, response) => {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) throw new Error("not a list");
      return { items: parsed, next: response.headers?.get?.("x-next-page") ?? "" };
    });
    all.push(...items);
    page = String(next).trim();
  }
  return all;
}

/* Cells that all succeeded, and at least one of them. */
function cellsPassed(jobs) {
  const cells = (Array.isArray(jobs) ? jobs : []).filter((job) => String(job?.name).startsWith("upgrade_cell"));
  return cells.length > 0 && cells.every((job) => job.status === "success");
}

/* The sha a passed pipeline vouches for, or "" when its gate file says nothing usable. */
function baseFromGate(text, pipelineSha) {
  const values = parseEnvFile(text);
  const verdict = values.get("UPGRADE_CELLS");
  if (verdict === "run") return SHA.test(String(pipelineSha)) ? pipelineSha : "";
  if (verdict === "skip") {
    const since = values.get("UPGRADE_CELLS_SINCE");
    return SHA.test(String(since)) ? since : "";
  }
  return "";
}

async function findBase({ env, fetchImpl, log }) {
  const token = env.ORBIT_REUSE_TOKEN;
  const base = (env.CI_API_V4_URL ?? "").replace(/\/+$/u, "");
  const project = encodeURIComponent(env.CI_PROJECT_ID ?? "");
  const options = { token, fetchImpl };
  const pipelines = await request(
    `${base}/projects/${project}/merge_requests/${encodeURIComponent(env.CI_MERGE_REQUEST_IID ?? "")}/pipelines`,
    options,
    parseJson,
  );
  const earlier = (Array.isArray(pipelines) ? pipelines : [])
    .filter((pipeline) => Number(pipeline?.id) !== Number(env.CI_PIPELINE_ID))
    .filter((pipeline) => !UNFINISHED.has(pipeline?.status))
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, MAX_PIPELINES);

  for (const pipeline of earlier) {
    const jobs = await requestAllPages(
      `${base}/projects/${project}/pipelines/${pipeline.id}/jobs?per_page=100`,
      options,
    );
    if (!cellsPassed(jobs)) continue;
    const classify = (Array.isArray(jobs) ? jobs : []).find((job) => job?.name === "classify");
    if (!classify) {
      log(`pipeline ${pipeline.id} passed its cells but has no classify job`);
      return "";
    }
    try {
      const text = await request(
        `${base}/projects/${project}/jobs/${classify.id}/artifacts/.orbit-upgrade/gate.env`,
        options,
        (body) => body,
      );
      return baseFromGate(text, pipeline.sha);
    } catch (error) {
      log(`pipeline ${pipeline.id}: its gate file is unreadable (${error.message})`);
      return "";
    }
  }
  return "";
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function changedPaths(base, cwd, log) {
  const diff = () => git(["diff", "-z", "--name-only", "--no-renames", base, "HEAD"], cwd);
  try {
    return diff().split("\0").filter(Boolean);
  } catch {
    log(`the base ${base} is not in this checkout: fetching it`);
  }
  git(["fetch", "--quiet", "origin", base], cwd);
  return diff().split("\0").filter(Boolean);
}

async function decide({ env, fetchImpl, cwd, log }) {
  if (env.CI_PIPELINE_SOURCE !== "merge_request_event" || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME !== "preview") {
    return { decision: "run", reason: "not a merge-request pipeline into preview" };
  }
  if (!env.ORBIT_REUSE_TOKEN) return { decision: "run", reason: "no read-only token (ORBIT_REUSE_TOKEN)" };
  if (labelled(env, "ci: rerun")) return { decision: "run", reason: "the merge request is labelled 'ci: rerun'" };
  if (String(env.ORBIT_REUSE ?? "").toLowerCase() === "off") return { decision: "run", reason: "ORBIT_REUSE=off" };
  if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !env.CI_MERGE_REQUEST_IID) {
    return { decision: "run", reason: "the API URL, project or merge request is unknown" };
  }

  const base = await findBase({ env, fetchImpl, log });
  if (!base) return { decision: "run", reason: "no earlier pipeline of this merge request has passed cells to stand on" };

  const paths = changedPaths(base, cwd, log);
  const relevant = paths.find(updateRelevant);
  if (relevant) return { decision: "run", reason: `${relevant} changed since ${base}` };
  return {
    decision: "skip",
    since: base,
    reason: `nothing update-relevant changed since ${base} (${paths.length} files)`,
  };
}

export async function run({
  env = process.env,
  argv = process.argv.slice(2),
  fetchImpl = fetch,
  cwd = process.cwd(),
  log = console.log,
} = {}) {
  const secrets = [env.ORBIT_REUSE_TOKEN, env.CI_JOB_TOKEN].filter(Boolean);
  const quiet = (line) => log(secrets.reduce((text, secret) => text.split(secret).join("***"), String(line)));
  let outcome;
  try {
    outcome = await decide({ env, fetchImpl, cwd, log: quiet });
  } catch (error) {
    outcome = { decision: "run", reason: `the check failed (${error.message})` };
  }

  const result = outcome.decision === "skip"
    ? { decision: "skip", since: outcome.since }
    : { decision: "run" };
  const lines = result.decision === "skip"
    ? `UPGRADE_CELLS=skip\nUPGRADE_CELLS_SINCE=${result.since}\n`
    : "UPGRADE_CELLS=run\n";
  const destination = argv[0];
  if (destination) {
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, lines);
  }
  quiet(`upgrade cells: ${result.decision}, ${outcome.reason}`);
  return result;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await run();
  } catch (error) {
    // Never the reason a pipeline fails: no verdict means the cells run.
    const secrets = [process.env.ORBIT_REUSE_TOKEN, process.env.CI_JOB_TOKEN].filter(Boolean);
    const message = secrets.reduce((text, secret) => text.split(secret).join("***"), String(error.message));
    console.log(`the upgrade-cells check failed (${message}): the cells run`);
  }
}
