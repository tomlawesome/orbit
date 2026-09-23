#!/usr/bin/env node
/*
 * Which candidate jobs can stand on an earlier run instead of running again
 * (ADR-0028, #1060 slice 3; replaces the #898 version).
 *
 * Called twice in a pipeline, because the keys are not all known at once:
 *
 *   classify      node scripts/ci/reuse-lookup.mjs .orbit-reuse/reuse.env
 *                 the jobs keyed on the source alone -- fast, fast_docker,
 *                 fidelity, integration, sidecar_images.
 *   build_image   node scripts/ci/reuse-lookup.mjs .orbit-reuse/reuse.env \
 *                   --artefact image --out .orbit-reuse/image.env
 *                 the six jobs keyed on the image, whose key exists only once
 *                 the content ID does. It writes their finished keys as well
 *                 as the verdicts, because a job that reuses nothing still has
 *                 to record evidence under the key it really ran on.
 *
 * For each job it walks the project's recent pipelines, newest first, on any
 * ref, and looks for a run of that same job that succeeded and recorded the
 * same key. The key names content, so a pass on another branch, or on `dev`,
 * against the same content is the same evidence: a rebase that changes nothing
 * under test keeps its reuse, and a new merge request whose first push leaves
 * the image unchanged stands on `dev`'s last full run. The first match wins,
 * and is written as
 *
 *   ORBIT_REUSE_<JOB>=<the job id that really did the work>
 *   ORBIT_REUSE_<JOB>_PIPELINE=<the pipeline that job ran in>
 *
 * Five rules keep this from ever weakening the gate:
 *
 *   - Merge-request pipelines only. A pipeline on dev, preview, main or a
 *     hotfix branch is the delivery gate: it records evidence and never
 *     consumes any.
 *   - Seven days. Evidence from a job that finished longer ago than that is
 *     not reused, matching ADR-0020's publication rule; a job whose finish
 *     time the API does not report is not reused either. Artefact expiry at
 *     14 days is the backstop.
 *   - The proof is the evidence artefact the job itself wrote as its last act,
 *     so a job that gated itself out, or that predates this change, has none
 *     and is never reused. A missing or malformed file means "did not really
 *     run", not "ran and passed".
 *   - Evidence that itself stands on an older run is followed to the run that
 *     really did the work, so a chain of reuses cannot drift.
 *   - Two escape hatches, for when a human does not believe the evidence: the
 *     merge-request label `ci: rerun` (read from CI_MERGE_REQUEST_LABELS, as
 *     `ci: acceptance` is) and ORBIT_REUSE=off on a pipeline started by hand.
 *     Either one turns the lookup off completely. "Retry" on a reused job
 *     reuses again; the label is the route.
 *
 * Nothing here may fail the job that calls it. Every network or parse failure
 * is logged and read as "no reuse", which reruns the job -- the safe direction.
 *
 * The credential is read-only and is sent as a header, never printed.
 * ORBIT_REUSE_TOKEN is what this wants: a token an unprotected merge-request
 * pipeline can read, with no write scope anywhere. BASE_REPIN_TOKEN is
 * accepted as a fallback because it is what #898 used, but since #1084 it is
 * protected and so is absent from exactly the pipelines that would reuse
 * anything. With neither set there is no lookup at all and every job runs.
 *
 * The API base URL is injectable (ORBIT_REUSE_API_URL) so the test can point
 * this at a local server and assert what it emits.
 */
import { appendFileSync, readFileSync } from "node:fs";

import {
  REUSE_PREFIX,
  compositeKey,
  inputsVariable,
  jobsOnArtefact,
  readConfig,
  sourceVariable,
  variableSuffix,
} from "./job-inputs.mjs";

/*
 * "The search walks the project's recent pipelines on any ref, newest first,
 * capped at about twenty" (ADR-0028 section 2). Twenty rather than #898's ten
 * because the walk is no longer confined to one merge request's own pipelines:
 * the evidence worth finding is often `dev`'s last full run.
 */
export const MAX_PIPELINES = 20;

/* ADR-0028 section 3, matching ADR-0020's publication rule. */
export const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 20_000;

/*
 * Where each artefact axis gets its value. `image` is the content ID
 * scripts/ci/image-content-id.sh derives and build_image puts in build.env.
 */
const ARTEFACT_VARIABLES = { image: "ORBIT_IMAGE_CONTENT_ID" };

export function reuseVariable(job) {
  return `${REUSE_PREFIX}${variableSuffix(job)}`;
}

/*
 * `KEY=value` lines, the same shape classify and build_image write. Values here
 * are hex digests and decimal ids, so no quoting or escaping is involved.
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

/* The merge-request labels, parsed as `ci: acceptance` is parsed in classify. */
export function labelled(env, label) {
  return String(env.CI_MERGE_REQUEST_LABELS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .includes(label);
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

/*
 * Whether a finished job is young enough to be believed. No finish time is
 * "no", not "probably fine": the age limit is the only thing bounding how long
 * a flaky pass can carry a merge request.
 */
export function withinAgeLimit(finishedAt, now) {
  if (!finishedAt) return false;
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(finished)) return false;
  return now - finished <= MAX_EVIDENCE_AGE_MS;
}

export async function lookupReuse({
  base,
  token,
  projectId,
  pipelineId,
  keys,
  now = Date.now(),
  log = () => {},
  fetchImpl = fetch,
}) {
  const options = { token, fetchImpl, log };
  const decided = new Map();
  const pending = new Set([...keys.keys()].filter((job) => keys.get(job)));
  if (pending.size === 0) return decided;

  let pipelines;
  try {
    pipelines = await requestJson(
      `${base}/projects/${encodeURIComponent(projectId)}/pipelines`
        + `?per_page=${MAX_PIPELINES}&order_by=id&sort=desc`,
      options,
    );
  } catch (error) {
    log(`the project's recent pipelines could not be listed (${error.message}): every job runs`);
    return decided;
  }

  const earlier = (Array.isArray(pipelines) ? pipelines : [])
    .filter((pipeline) => Number(pipeline?.id) !== Number(pipelineId))
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, MAX_PIPELINES);

  if (earlier.length === 0) {
    log("the project has no earlier pipeline to stand on: every job runs");
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
      if (!withinAgeLimit(candidate.finished_at, now)) {
        log(`  ${job}: job ${candidate.id} finished too long ago (${candidate.finished_at ?? "no finish time"})`);
        continue;
      }
      const evidence = await readEvidence(base, projectId, candidate.id, job, options);
      if (!evidence) continue;
      if (evidence.inputs !== keys.get(job)) {
        log(`  ${job}: job ${candidate.id} in pipeline ${pipeline.id} ran on a different key`);
        continue;
      }
      // Evidence written by a run that itself stood on an older one names that
      // older run, so this follows the chain to the job that did the work.
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

/*
 * Why the lookup is off, or "" when it is on. Separate from run() so the reason
 * is one decision with one log line, and so the finished keys are written first
 * either way: a delivery pipeline reuses nothing and still has to record
 * evidence under the key it ran on, or nothing downstream could ever stand on
 * it.
 */
export function refusal(env) {
  if (env.CI_PIPELINE_SOURCE !== "merge_request_event") {
    return "reuse is a merge-request economy: a delivery pipeline records evidence and consumes none";
  }
  if (String(env.ORBIT_REUSE ?? "").toLowerCase() === "off") {
    return "ORBIT_REUSE=off: every job runs";
  }
  if (labelled(env, "ci: rerun")) {
    return "the merge request is labelled 'ci: rerun': every job runs (remove the label or every push reruns everything)";
  }
  if (!(env.ORBIT_REUSE_TOKEN || env.BASE_REPIN_TOKEN)) {
    return "no read-only token (ORBIT_REUSE_TOKEN), so earlier runs cannot be read: every job runs";
  }
  if (!(env.ORBIT_REUSE_API_URL || env.CI_API_V4_URL) || !env.CI_PROJECT_ID) {
    return "the API URL or the project is unknown: every job runs";
  }
  return "";
}

export async function run({
  env = process.env,
  envFile,
  artefact = "",
  outFile,
  now = Date.now(),
  log = console.log,
  fetchImpl = fetch,
} = {}) {
  const config = readConfig();
  const candidates = jobsOnArtefact(config, artefact);
  const destination = outFile ?? envFile;
  const declared = parseEnvFile(envFile ? readFileSync(envFile, "utf8") : "");

  // In artefact mode the keys are finished here and written whatever happens
  // next, because reuse-evidence.sh reads them back to label this pipeline's
  // own evidence.
  const keys = new Map();
  if (artefact) {
    const variable = ARTEFACT_VARIABLES[artefact];
    const artefactId = variable ? env[variable] : undefined;
    if (!artefactId) {
      log(`${variable ?? artefact} is unset, so no ${artefact} job has a key: every one of them runs`);
      return "";
    }
    const lines = [];
    for (const job of candidates) {
      const source = declared.get(sourceVariable(job));
      if (!source) {
        log(`${job}: classify published no source key, so it runs`);
        continue;
      }
      const key = compositeKey(job, source, artefactId);
      keys.set(job, key);
      lines.push(`${inputsVariable(job)}=${key}`);
    }
    if (lines.length > 0 && destination) appendFileSync(destination, `${lines.join("\n")}\n`);
  } else {
    for (const job of candidates) keys.set(job, declared.get(inputsVariable(job)));
  }

  const off = refusal(env);
  if (off) {
    log(off);
    return "";
  }

  const decided = await lookupReuse({
    base: (env.ORBIT_REUSE_API_URL || env.CI_API_V4_URL).replace(/\/+$/u, ""),
    token: env.ORBIT_REUSE_TOKEN || env.BASE_REPIN_TOKEN,
    projectId: env.CI_PROJECT_ID,
    pipelineId: env.CI_PIPELINE_ID,
    keys,
    now,
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
  if (lines && destination) appendFileSync(destination, `${lines}\n`);
  return lines;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  try {
    await run({
      envFile: argv[0],
      artefact: option(argv, "--artefact") ?? "",
      outFile: option(argv, "--out"),
    });
  } catch (error) {
    // Never the reason a pipeline fails: no verdict means every job runs.
    console.log(`the reuse lookup failed (${error.message}): every job runs`);
  }
}
