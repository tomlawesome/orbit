#!/usr/bin/env node
/*
 * Which candidate jobs can stand on an earlier run instead of running again
 * (#898).
 *
 * Called by `classify`, once, with the file the input hashes were just written
 * to. For each candidate job it walks this merge request's earlier pipelines,
 * newest first, and looks for a run of that same job that succeeded and
 * recorded the same input hash. The first one it finds wins, and is appended to
 * the file as
 *
 *   ORBIT_REUSE_<JOB>=<the job id that really did the work>
 *   ORBIT_REUSE_<JOB>_PIPELINE=<the pipeline that job ran in>
 *
 * Three rules keep this from ever weakening the gate:
 *
 *   - Merge-request pipelines only. A pipeline on dev, preview, main or a
 *     hotfix branch is the delivery gate and always runs everything.
 *   - The proof is the evidence artefact the job itself wrote as its last act,
 *     so a job that gated itself out, or that predates this change, has none
 *     and is never reused. A missing or malformed file means "did not really
 *     run", not "ran and passed".
 *   - Evidence that itself stands on an older run is followed to the run that
 *     really did the work, so a chain of reuses cannot drift.
 *
 * Nothing here may fail `classify`. Every network or parse failure is logged
 * and read as "no reuse", which reruns the job -- the safe direction.
 *
 * The token is BASE_REPIN_TOKEN, the one credential an unprotected
 * merge-request pipeline can read (see its comment block in .gitlab-ci.yml).
 * It is sent as a header and never printed. Unset means no lookup at all.
 *
 * The API base URL is injectable (ORBIT_REUSE_API_URL) so the test can point
 * this at a local server and assert what it emits.
 */
import { appendFileSync, readFileSync } from "node:fs";

import { REUSE_PREFIX, inputsVariable, jobNames, readConfig, variableSuffix } from "./job-inputs.mjs";

/* Ten is plenty: it is the fix-after-a-red-job case, not an archive search. */
export const MAX_PIPELINES = 10;
const REQUEST_TIMEOUT_MS = 20_000;

export function reuseVariable(job) {
  return `${REUSE_PREFIX}${variableSuffix(job)}`;
}

/*
 * `KEY=value` lines, the same shape `classify` writes. Values here are hex
 * digests and decimal ids, so no quoting or escaping is involved.
 */
export function parseEnvFile(text) {
  const values = new Map();
  for (const line of String(text).split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

async function requestJson(url, { token, fetchImpl }) {
  const response = await fetchImpl(url, {
    headers: { "PRIVATE-TOKEN": token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = new Error(`${url.replace(/\/\/[^/]*@/u, "//")} answered ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

/*
 * The evidence a job wrote, or null when it wrote none. A 404 is the ordinary
 * answer for a job that gated itself out, so it is not logged as a failure;
 * anything else is.
 */
async function readEvidence(base, projectId, jobId, job, options) {
  const url = `${base}/projects/${encodeURIComponent(projectId)}/jobs/${jobId}`
    + `/artifacts/ci-evidence/${encodeURIComponent(job)}.json`;
  try {
    const evidence = await requestJson(url, options);
    if (!evidence || typeof evidence.inputs !== "string") return null;
    return evidence;
  } catch (error) {
    if (error.status !== 404) options.log(`  ${job}: evidence from job ${jobId} unreadable (${error.message})`);
    return null;
  }
}

/*
 * The successful run of each named job in one pipeline. A retried job appears
 * more than once, so the highest id wins -- the run that stands.
 */
export function successfulJobs(jobs) {
  const found = new Map();
  for (const entry of jobs) {
    if (entry?.status !== "success") continue;
    const previous = found.get(entry.name);
    if (!previous || Number(entry.id) > Number(previous.id)) found.set(entry.name, entry);
  }
  return found;
}

export async function lookupReuse({
  base,
  token,
  projectId,
  mergeRequestIid,
  pipelineId,
  hashes,
  log = () => {},
  fetchImpl = fetch,
}) {
  const options = { token, fetchImpl, log };
  const decided = new Map();
  const pending = new Set([...hashes.keys()].filter((job) => hashes.get(job)));

  let pipelines;
  try {
    pipelines = await requestJson(
      `${base}/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mergeRequestIid)}/pipelines`,
      options,
    );
  } catch (error) {
    log(`the earlier pipelines of this merge request could not be listed (${error.message}): every job runs`);
    return decided;
  }

  const earlier = (Array.isArray(pipelines) ? pipelines : [])
    .filter((pipeline) => Number(pipeline?.id) !== Number(pipelineId))
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, MAX_PIPELINES);

  if (earlier.length === 0) {
    log("this merge request has no earlier pipeline: every job runs");
    return decided;
  }

  for (const pipeline of earlier) {
    if (pending.size === 0) break;
    let jobs;
    try {
      jobs = await requestJson(
        `${base}/projects/${encodeURIComponent(projectId)}/pipelines/${pipeline.id}/jobs?per_page=100`,
        options,
      );
    } catch (error) {
      log(`  pipeline ${pipeline.id}: its jobs could not be listed (${error.message})`);
      continue;
    }
    const succeeded = successfulJobs(Array.isArray(jobs) ? jobs : []);
    for (const job of [...pending]) {
      const candidate = succeeded.get(job);
      if (!candidate) continue;
      const evidence = await readEvidence(base, projectId, candidate.id, job, options);
      if (!evidence) continue;
      if (evidence.inputs !== hashes.get(job)) {
        log(`  ${job}: job ${candidate.id} in pipeline ${pipeline.id} ran on different inputs`);
        continue;
      }
      // Evidence written by a run that itself stood on an older one names that
      // older run, so this follows the chain to the job that has the artefacts.
      decided.set(job, {
        jobId: Number(evidence.stands_on ?? candidate.id),
        pipelineId: Number(evidence.stands_on_pipeline ?? evidence.pipeline ?? pipeline.id),
      });
      pending.delete(job);
    }
  }

  return decided;
}

export function formatDecisions(decided) {
  return [...decided]
    .map(([job, { jobId, pipelineId }]) => `${reuseVariable(job)}=${jobId}\n${reuseVariable(job)}_PIPELINE=${pipelineId}`)
    .join("\n");
}

export async function run({ env = process.env, envFile, log = console.log, fetchImpl = fetch } = {}) {
  const config = readConfig();
  const candidates = jobNames(config);

  if (env.CI_PIPELINE_SOURCE !== "merge_request_event") {
    log("reuse is a merge-request economy: this pipeline runs every job (#898)");
    return "";
  }
  if (!env.BASE_REPIN_TOKEN) {
    log("BASE_REPIN_TOKEN is unset, so earlier runs cannot be read: every job runs");
    return "";
  }
  const base = env.ORBIT_REUSE_API_URL || env.CI_API_V4_URL;
  if (!base || !env.CI_PROJECT_ID || !env.CI_MERGE_REQUEST_IID) {
    log("the API URL, project or merge request is unknown: every job runs");
    return "";
  }

  const declared = parseEnvFile(envFile ? readFileSync(envFile, "utf8") : "");
  const hashes = new Map(candidates.map((job) => [job, declared.get(inputsVariable(job))]));

  const decided = await lookupReuse({
    base: base.replace(/\/+$/u, ""),
    token: env.BASE_REPIN_TOKEN,
    projectId: env.CI_PROJECT_ID,
    mergeRequestIid: env.CI_MERGE_REQUEST_IID,
    pipelineId: env.CI_PIPELINE_ID,
    hashes,
    log,
    fetchImpl,
  });

  for (const job of candidates) {
    const decision = decided.get(job);
    log(decision
      ? `${job}: stands on job ${decision.jobId} from pipeline ${decision.pipelineId}`
      : `${job}: runs`);
  }

  const lines = formatDecisions(decided);
  if (lines && envFile) appendFileSync(envFile, `${lines}\n`);
  return lines;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await run({ envFile: process.argv[2] });
  } catch (error) {
    // Never the reason a pipeline fails: no verdict means every job runs.
    console.log(`the reuse lookup failed (${error.message}): every job runs`);
  }
}
