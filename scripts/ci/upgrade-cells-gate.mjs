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
 * It also records this pipeline's upgrade slot tags (ORBIT_UPGRADE_SLOT_*, read
 * from the environment), because a new stable tag changes what the cells test
 * without touching a path. classify keeps the file as an artefact, so later
 * pipelines can read it, and a chain of skips always leads back to a pipeline
 * that really ran.
 *
 * The cells run unless this is a merge-request pipeline into `preview`, none of
 * the reuse lookup's escape hatches is pulled (no ORBIT_REUSE_TOKEN, the label
 * `ci: rerun`, ORBIT_REUSE=off) and a passed run stands on a base B with the
 * same inputs (#1767): it ran in a merge-request pipeline into `preview` (this
 * merge request's or another's), its gate artefact names B, nothing an update
 * depends on changed between B and this head, and its slot tags equal this
 * pipeline's. Runs are tried newest first; one whose inputs differ is passed
 * over, but one whose data is missing or unreadable (a gate file with no slot
 * tags included) ends the search with "run". No slot tags here means "run".
 *
 * Nothing here may fail the job that calls it: any API, parse or git error is
 * logged and read as "run". The token is sent as a header, never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

import { MAX_PIPELINES, labelled, parseEnvFile } from "./reuse-lookup.mjs";
import { LAUNCHER_PIN, UPGRADE_MATRIX_PATTERNS } from "./upgrade-versions.mjs";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 1024 * 1024;
const MAX_JOB_PAGES = 20;
/* Of the MAX_PIPELINES job listings read, at most this many go to this merge
   request's own pipelines, so a long run of its failures cannot crowd out a
   passed run on another merge request into preview. */
const MAX_OWN_PIPELINES = 10;
const LISTING_PAGE_SIZE = 100;
const SLOT_KEY = /^ORBIT_UPGRADE_SLOT_[A-Z0-9_]+$/u;
const SLOT_VALUE = /^[A-Za-z0-9._+-]*$/u;
const MR_REF = /^refs\/merge-requests\/(\d+)\/(?:head|merge|train)$/u;
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

/* Everything the upgrade matrix and the launcher cell watch is relevant too,
   read from upgrade-versions.mjs rather than listed twice (#1722 D-F4): a
   path the matrix arms on must never be skipped here. */
export function updateRelevant(path) {
  return path === LAUNCHER_PIN
    || UPGRADE_MATRIX_PATTERNS.some((pattern) => pattern.test(path))
    || INSTALLER_SCRIPTS.has(path)
    || /^docker-compose[^/]*\.yml$/u.test(path)
    || path.startsWith("compose/")
    || path.startsWith("drizzle/")
    || path === ".env-orbit.example"
    || path.startsWith("config/")
    /* a pattern, not a quoted prefix: the CI input scan (job-inputs.mjs)
       reads a bare "scripts/ci/..." string in code as a file it must hash */
    || /^scripts\/ci\/upgrade-/u.test(path)
    || path === "scripts/ci/write-test-manifest.sh"
    || path === "scripts/ci/checkout-launcher-source.sh"
    || path === "scripts/ci/start-installer-registry.sh"
    /* the sidecar the oidc cell builds (upgrade-cell.sh) */
    || path.startsWith("tests/oidc/");
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

/* The slot tags in a set of KEY=value pairs, as one comparable string. */
function slotTags(entries) {
  return [...entries]
    .filter(([key]) => SLOT_KEY.test(key))
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .sort()
    .join("\n");
}

/* This merge request's own finished pipelines, and the finished
   merge-request pipelines of every other merge request into preview, newest
   first, within the job-listing budget. A listing that cannot be read throws:
   the cells run. */
async function candidates({ env, base, project, options }) {
  const ownIid = String(env.CI_MERGE_REQUEST_IID);
  const own = await request(
    `${base}/projects/${project}/merge_requests/${encodeURIComponent(ownIid)}/pipelines`,
    options,
    parseJson,
  );
  const requests = await request(
    `${base}/projects/${project}/merge_requests?target_branch=preview&state=all`
      + `&order_by=updated_at&sort=desc&per_page=${LISTING_PAGE_SIZE}`,
    options,
    parseJson,
  );
  const listed = await request(
    `${base}/projects/${project}/pipelines?source=merge_request_event`
      + `&order_by=id&sort=desc&per_page=${LISTING_PAGE_SIZE}`,
    options,
    parseJson,
  );
  if (![own, requests, listed].every(Array.isArray)) throw new Error("a listing is not a list");

  const intoPreview = new Set(requests
    .filter((entry) => entry?.target_branch === "preview")
    .map((entry) => String(entry.iid)));
  const finished = (pipeline) => Number.isSafeInteger(Number(pipeline?.id))
    && Number(pipeline.id) !== Number(env.CI_PIPELINE_ID)
    && !UNFINISHED.has(pipeline?.status);
  const newestFirst = (left, right) => Number(right.id) - Number(left.id);

  const ownRuns = new Map();
  const otherRuns = new Map();
  for (const pipeline of own.filter(finished)) ownRuns.set(Number(pipeline.id), pipeline);
  for (const pipeline of listed.filter(finished)) {
    // U2: only a merge-request pipeline of a merge request into preview counts.
    if (pipeline.source !== "merge_request_event") continue;
    const iid = String(pipeline.ref ?? "").match(MR_REF)?.[1];
    if (iid === ownIid) ownRuns.set(Number(pipeline.id), pipeline);
    else if (iid && intoPreview.has(iid)) otherRuns.set(Number(pipeline.id), pipeline);
  }
  const ownNewest = [...ownRuns.values()].sort(newestFirst).slice(0, MAX_OWN_PIPELINES);
  const others = [...otherRuns.values()].filter((pipeline) => !ownRuns.has(Number(pipeline.id)));
  return [...ownNewest, ...others].sort(newestFirst).slice(0, MAX_PIPELINES);
}

/*
 * The newest passed run whose inputs match this pipeline's, as
 * { pipeline, base, paths }, or a reason to run. Missing or unreadable data on
 * a passed run ends the search with a run; different inputs pass it over.
 */
async function findReuse({ env, fetchImpl, cwd, log }) {
  const token = env.ORBIT_REUSE_TOKEN;
  const base = (env.CI_API_V4_URL ?? "").replace(/\/+$/u, "");
  const project = encodeURIComponent(env.CI_PROJECT_ID ?? "");
  const options = { token, fetchImpl };
  const ownSlots = slotTags(Object.entries(env));
  // No slot tags here means no run can be shown to have tested the same ones.
  if (!ownSlots) return { reason: "this pipeline has no upgrade slot tags (ORBIT_UPGRADE_SLOT_*)" };
  const passedOver = [];

  for (const pipeline of await candidates({ env, base, project, options })) {
    const jobs = await requestAllPages(
      `${base}/projects/${project}/pipelines/${pipeline.id}/jobs?per_page=100`,
      options,
    );
    if (!cellsPassed(jobs)) continue;
    const doubt = (why) => ({ reason: `pipeline ${pipeline.id} passed its cells but ${why}` });
    if (!SHA.test(String(pipeline.sha))) return doubt("its sha is not a commit sha");
    const classify = jobs.find((job) => job?.name === "classify");
    if (!classify) return doubt("has no classify job");
    let text;
    try {
      text = await request(
        `${base}/projects/${project}/jobs/${encodeURIComponent(classify.id)}/artifacts/.orbit-upgrade/gate.env`,
        options,
        (body) => body,
      );
    } catch (error) {
      return doubt(`its gate file is unreadable (${error.message})`);
    }
    const since = baseFromGate(text, pipeline.sha);
    if (!since) return doubt("its gate file names no base");

    const runSlots = slotTags(parseEnvFile(text));
    // A gate file with no slot lines (one written before #1767) is missing data.
    if (!runSlots) return doubt("its gate file records no slot tags");
    if (runSlots !== ownSlots) {
      passedOver.push(`pipeline ${pipeline.id} ran with other slot tags`);
      log(`pipeline ${pipeline.id} (${pipeline.sha}) passed on base ${since} with other slot tags: not reused`);
      continue;
    }
    const paths = changedPaths(since, cwd, log);
    const relevant = paths.find(updateRelevant);
    if (relevant) {
      passedOver.push(`${relevant} changed since ${since}, the base of pipeline ${pipeline.id}`);
      log(`pipeline ${pipeline.id} (${pipeline.sha}) passed on base ${since}, but ${relevant} changed since: not reused`);
      continue;
    }
    return { pipeline, base: since, paths };
  }
  return {
    reason: passedOver.length > 0
      ? passedOver.join("; ")
      : "no earlier merge-request pipeline into preview has passed cells to stand on",
  };
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

  const found = await findReuse({ env, fetchImpl, cwd, log });
  if (!found.pipeline) return { decision: "run", reason: found.reason };
  const { pipeline, base, paths } = found;
  return {
    decision: "skip",
    since: base,
    reason: `reusing pipeline ${pipeline.id} (${pipeline.sha}), which passed its cells on base ${base} `
      + `with the same slot tags; nothing update-relevant changed since ${base} (${paths.length} files)`,
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
  const verdict = result.decision === "skip"
    ? `UPGRADE_CELLS=skip\nUPGRADE_CELLS_SINCE=${result.since}\n`
    : "UPGRADE_CELLS=run\n";
  // A tag that could not be written back unchanged is left out, so a later
  // pipeline sees different tags and runs.
  const slots = Object.entries(env)
    .filter(([key, value]) => SLOT_KEY.test(key) && SLOT_VALUE.test(String(value ?? "")))
    .map(([key, value]) => `${key}=${value ?? ""}\n`)
    .sort()
    .join("");
  const lines = verdict + slots;
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
