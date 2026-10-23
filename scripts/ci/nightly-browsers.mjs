#!/usr/bin/env node
/*
 * The nightly browser run on `dev` (#1412): three small questions the pipeline
 * asks GitLab, in one file.
 *
 *   moved    Has `dev` moved since the last nightly run? Prints `idle` when the
 *            last nightly pipeline ran on this very commit, otherwise `run`.
 *            Any doubt prints `run`: a night that tests twice costs minutes, a
 *            night that wrongly skips costs a day's coverage.
 *   blocked  Did a nightly run on this commit fail? Exit 1, naming the runs, if
 *            so. The dev -> preview merge request asks it (`nightly_not_red`).
 *   report   File the failure: one issue in the nearest open milestone, or a
 *            comment on the one already open. The nightly's last job
 *            (`nightly_report`, on_failure) calls it.
 *
 * A nightly pipeline is a schedule pipeline on `dev` that has a `classify` job:
 * no other schedule starts one. The other schedules on `dev` (Renovate, base
 * image re-pin, door import) are skipped by that test.
 *
 * Credentials. Reading uses ORBIT_REUSE_TOKEN, else BASE_REPIN_TOKEN, else
 * SIDECAR_ISSUE_TOKEN, the same order of preference as the reuse lookup. Filing
 * needs SIDECAR_ISSUE_TOKEN (an `api` project token) and fails clearly without
 * it. The token travels in a header and is never printed.
 */
import { pathToFileURL } from "node:url";

/* How many schedule pipelines on `dev` are walked looking for a nightly. */
export const MAX_SCHEDULE_PIPELINES = 40;

/* Cap on failing-test lines quoted per failed job. */
export const MAX_TEST_LINES = 15;

export const ISSUE_TITLE = "Nightly browser run failed on dev";
const ISSUE_LABELS = "ci";
const REQUEST_TIMEOUT_MS = 20_000;

/* Pipelines that never ran the browsers, or were abandoned, say nothing. */
const IGNORED_STATUSES = new Set(["canceled", "cancelled", "skipped", "manual", "scheduled"]);

async function request(url, { token, fetchImpl, method = "GET", body, raw = false }) {
  const headers = { "PRIVATE-TOKEN": token };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`${method} ${url.replace(/\?.*$/u, "")} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return raw ? response.text() : response.json();
}

function project(base, projectId) {
  return `${base.replace(/\/$/u, "")}/projects/${encodeURIComponent(projectId)}`;
}

function query(parameters) {
  return new URLSearchParams(parameters).toString();
}

export function readToken(env) {
  return env.ORBIT_REUSE_TOKEN || env.BASE_REPIN_TOKEN || env.SIDECAR_ISSUE_TOKEN || "";
}

/*
 * Nightly pipelines on `dev`, newest first, with the pipelines of other
 * schedules removed. `sha` narrows to one commit when given.
 */
export async function nightlyPipelines({ base, projectId, options, sha, skipId, log = () => {} }) {
  const parameters = { source: "schedule", per_page: String(MAX_SCHEDULE_PIPELINES), order_by: "id", sort: "desc" };
  if (sha) parameters.sha = sha;
  else parameters.ref = "dev";
  const listed = await request(`${project(base, projectId)}/pipelines?${query(parameters)}`, options);
  const found = [];
  for (const pipeline of Array.isArray(listed) ? listed : []) {
    if (Number(pipeline.id) === Number(skipId)) continue;
    if (IGNORED_STATUSES.has(pipeline.status)) continue;
    if (pipeline.ref && pipeline.ref !== "dev") continue;
    let jobs;
    try {
      jobs = await request(`${project(base, projectId)}/pipelines/${pipeline.id}/jobs?per_page=100`, options);
    } catch (error) {
      log(`  pipeline ${pipeline.id}: its jobs could not be listed (${error.message})`);
      continue;
    }
    if (Array.isArray(jobs) && jobs.some((job) => job.name === "classify")) found.push(pipeline);
  }
  return found;
}

/* `idle` when the newest earlier nightly ran on this commit, else `run`. */
export async function moved({ base, projectId, pipelineId, sha, token, fetchImpl = fetch, log = () => {} }) {
  const options = { token, fetchImpl };
  let nightlies;
  try {
    nightlies = await nightlyPipelines({ base, projectId, options, skipId: pipelineId, log });
  } catch (error) {
    log(`the schedule pipelines could not be listed (${error.message}): running`);
    return "run";
  }
  const [last] = nightlies;
  if (!last) {
    log("no earlier nightly run: running");
    return "run";
  }
  if (last.sha === sha) {
    log(`dev is still at ${sha.slice(0, 12)}, where nightly pipeline ${last.id} (${last.status}) ran: nothing new to test`);
    return "idle";
  }
  log(`dev has moved since nightly pipeline ${last.id} (${String(last.sha).slice(0, 12)}): running`);
  return "run";
}

/* The nightly runs on `sha` that failed. An empty list means go ahead. */
export async function failedNightlies({ base, projectId, sha, token, fetchImpl = fetch, log = () => {} }) {
  const options = { token, fetchImpl };
  const nightlies = await nightlyPipelines({ base, projectId, options, sha, log });
  return nightlies.filter((pipeline) => pipeline.status === "failed");
}

/* Failing test titles out of a job log: Playwright's `  1) [project] › ...`
 * and Vitest's ` FAIL  file > test` lines, ANSI colour removed. */
export function failingTests(trace) {
  // eslint-disable-next-line no-control-regex
  const plain = String(trace).replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "").replace(/\r/gu, "");
  const lines = plain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+\) \[[^\]]+\] › /u.test(line) || /^FAIL {1,2}\S/u.test(line));
  return [...new Set(lines)].slice(0, MAX_TEST_LINES);
}

/* Lowest `M<number>` among the open milestones: the nearest one. */
export function nearestMilestone(milestones) {
  let best = null;
  for (const milestone of Array.isArray(milestones) ? milestones : []) {
    const match = /^M(\d+)\b/u.exec(String(milestone.title ?? ""));
    if (!match) continue;
    const number = Number(match[1]);
    if (!best || number < best.number) best = { number, id: milestone.id, title: milestone.title };
  }
  return best;
}

export function issueBody({ pipelineUrl, sha, failed }) {
  const lines = [
    `The nightly browser run on \`dev\` failed at ${String(sha).slice(0, 12)}.`,
    `Pipeline: ${pipelineUrl}`,
    "",
    "Failed jobs:",
  ];
  for (const job of failed) {
    lines.push(`- \`${job.name}\` (${job.failure_reason ?? "script failure"}): ${job.web_url}`);
    for (const test of job.tests ?? []) lines.push(`  - ${test}`);
  }
  lines.push(
    "",
    "The promotion to `preview` stops while this run is red on the same commit. Fix, then retry the failed job; the check reads the pipeline's status as it is now.",
  );
  return lines.join("\n");
}

export async function report({ base, projectId, pipelineId, pipelineUrl, sha, token, fetchImpl = fetch, log = () => {} }) {
  const options = { token, fetchImpl };
  const api = project(base, projectId);

  const jobs = await request(`${api}/pipelines/${pipelineId}/jobs?${query({ "scope[]": "failed", per_page: "100" })}`, options);
  const failed = (Array.isArray(jobs) ? jobs : []).filter((job) => !job.allow_failure);
  for (const job of failed) {
    try {
      job.tests = failingTests(await request(`${api}/jobs/${job.id}/trace`, { ...options, raw: true }));
    } catch (error) {
      log(`  ${job.name}: its log could not be read (${error.message})`);
      job.tests = [];
    }
  }
  const body = issueBody({ pipelineUrl, sha, failed });

  const open = await request(
    `${api}/issues?${query({ state: "opened", search: ISSUE_TITLE, in: "title", per_page: "20" })}`,
    options,
  );
  const existing = (Array.isArray(open) ? open : []).find((issue) => issue.title === ISSUE_TITLE);
  if (existing) {
    await request(`${api}/issues/${existing.iid}/notes`, { ...options, method: "POST", body: { body } });
    log(`nightly: commented on issue #${existing.iid}`);
    return { action: "commented", iid: existing.iid };
  }

  let milestone = null;
  try {
    milestone = nearestMilestone(await request(`${api}/milestones?${query({ state: "active", per_page: "100" })}`, options));
  } catch (error) {
    log(`nightly: milestones could not be read (${error.message}); filing without one`);
  }
  if (!milestone) log("nightly: no open milestone found; filing without one");
  const created = await request(`${api}/issues`, {
    ...options,
    method: "POST",
    body: {
      title: ISSUE_TITLE,
      description: body,
      labels: ISSUE_LABELS,
      ...(milestone ? { milestone_id: milestone.id } : {}),
    },
  });
  log(`nightly: created issue #${created.iid}${milestone ? ` in ${milestone.title}` : ""}`);
  return { action: "created", iid: created.iid };
}

function missing(env, names) {
  return names.filter((name) => !env[name]);
}

export async function main(argv, env = process.env, { fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  const [command] = argv;
  const base = env.ORBIT_NIGHTLY_API_URL || env.CI_API_V4_URL;
  const projectId = env.CI_PROJECT_ID;
  const log = (message) => err(`nightly-browsers: ${message}`);

  if (command === "moved") {
    // Never fails: a doubt is a run.
    const gaps = missing({ base, projectId, CI_COMMIT_SHA: env.CI_COMMIT_SHA, token: readToken(env) }, ["base", "projectId", "CI_COMMIT_SHA", "token"]);
    if (gaps.length > 0) {
      log(`cannot ask GitLab (${gaps.join(", ")} unknown): running`);
      out("run");
      return 0;
    }
    out(await moved({ base, projectId, pipelineId: env.CI_PIPELINE_ID, sha: env.CI_COMMIT_SHA, token: readToken(env), fetchImpl, log }));
    return 0;
  }

  if (command === "blocked") {
    const sha = env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA;
    const token = readToken(env);
    if (!token) {
      err("nightly-browsers: no read-only token. Create a project access token on ai/orbit with the `read_api` scope, leave it UNprotected (merge-request pipelines must see it) and set it as the masked CI/CD variable ORBIT_REUSE_TOKEN. Until then this check cannot tell whether the nightly run is red.");
      return 1;
    }
    if (!base || !projectId || !sha) {
      err("nightly-browsers: the API URL, project or commit is unknown; this must run inside a GitLab job.");
      return 1;
    }
    let failed;
    try {
      failed = await failedNightlies({ base, projectId, sha, token, fetchImpl, log });
    } catch (error) {
      err(`nightly-browsers: could not read the nightly runs (${error.message}); an unchecked promotion is not a passed one.`);
      return 1;
    }
    if (failed.length === 0) {
      out(`no failed nightly run on ${sha.slice(0, 12)}`);
      return 0;
    }
    err(`nightly-browsers: the nightly browser run failed on this dev commit (${sha.slice(0, 12)}):`);
    for (const pipeline of failed) err(`  ${pipeline.web_url ?? `pipeline ${pipeline.id}`}`);
    err("Fix it and retry the failed job, or promote a different dev commit.");
    return 1;
  }

  if (command === "report") {
    const token = env.SIDECAR_ISSUE_TOKEN;
    if (!token) {
      err("nightly-browsers: SIDECAR_ISSUE_TOKEN is not set. Create a project access token on ai/orbit (scope: api) and set it as a masked CI/CD variable named SIDECAR_ISSUE_TOKEN before the nightly can file an issue. The night is still red.");
      return 1;
    }
    const gaps = missing(
      { base, projectId, CI_PIPELINE_ID: env.CI_PIPELINE_ID, CI_PIPELINE_URL: env.CI_PIPELINE_URL, CI_COMMIT_SHA: env.CI_COMMIT_SHA },
      ["base", "projectId", "CI_PIPELINE_ID", "CI_PIPELINE_URL", "CI_COMMIT_SHA"],
    );
    if (gaps.length > 0) {
      err(`nightly-browsers: ${gaps.join(", ")} not set; this must run inside a GitLab job.`);
      return 1;
    }
    try {
      await report({
        base,
        projectId,
        pipelineId: env.CI_PIPELINE_ID,
        pipelineUrl: env.CI_PIPELINE_URL,
        sha: env.CI_COMMIT_SHA,
        token,
        fetchImpl,
        log,
      });
    } catch (error) {
      err(`nightly-browsers: could not file the issue (${error.message})`);
      return 1;
    }
    return 0;
  }

  err("usage: nightly-browsers.mjs moved | blocked | report");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
