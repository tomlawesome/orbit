#!/usr/bin/env node
/*
 * The promotion gate's launch-timing record, and its comparison with the
 * previous release candidate (#1048, owner 2026-09-18).
 *
 * web/tests/fidelity/launch-timing.spec.js writes one JSON file per theme
 * pack. This collects them into a single report, fetches the report the last
 * accepted promotion left behind, and prints the two side by side.
 *
 * Candidate against candidate, not commit against parent. A single commit's
 * effect on frame timings never rises above the run-to-run noise on this
 * hardware; the drift accumulated between one promotion and the next can.
 * The previous candidate's report is simply this job's own artefact from the
 * last successful run on the promotion branch, so "the accepted baseline" is
 * stored by the act of promoting and needs no separate commit.
 *
 * It prints and it records. It does not fail the job on a number, because
 * nobody has yet measured what this measurement's noise floor is on the quiet
 * lane -- one run is all that exists. A threshold invented now would be a
 * number with nothing behind it, which is how #873 got into trouble. What
 * would earn one: three or four promotions' reports from the same lane, or a
 * single job run with `--repeat-each`, so the spread of an unchanged build is
 * known and a regression can be called against it. Until then the report is
 * read by a human at the gate, and the commit range below is what they
 * bisect.
 *
 * Usage: launch-timing-report.mjs <directory>
 *
 * Environment:
 *   ORBIT_LAUNCH_TIMING_REF   branch whose last successful run holds the
 *                             previous candidate's report (default: preview)
 *   ORBIT_LAUNCH_TIMING_JOB   the job name to read it from
 *   ORBIT_LAUNCH_TIMING_BASELINE_FILE
 *                             read the previous candidate from this file
 *                             instead of the API -- how the tests drive the
 *                             comparison, and how a local run compares
 *                             against an artefact downloaded by hand
 *   BASE_REPIN_TOKEN          the credential an unprotected merge-request
 *                             pipeline can read; sent as a header from inside
 *                             this process, never on a command line. Absent,
 *                             unreachable or expired all read as "no previous
 *                             candidate", which is never a failure.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPORT_NAME = "report.json";
const PHASES = ["create", "home"];
const METRICS = ["mean", "max", "over32", "over50"];

/** Every pack file the spec left behind, keyed by pack name. */
function readPacks(directory) {
  const packs = {};
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json") || name === REPORT_NAME) continue;
    const measured = JSON.parse(readFileSync(join(directory, name), "utf8"));
    packs[measured.pack ?? name.replace(/\.json$/u, "")] = measured;
  }
  return packs;
}

/*
 * What this run covers. On the promotion push it is the push's own range; on
 * the merge request it is the merge base to the tip. Both are recorded, but
 * the range a regression is bisected over is baseline-commit..this-commit,
 * added below once the previous candidate is known -- that is the span the
 * comparison actually spans, however many merges deep it is.
 */
function pipelineRange() {
  const zero = "0".repeat(40);
  const head = process.env.CI_COMMIT_SHA ?? null;
  const base =
    process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA ||
    (process.env.CI_COMMIT_BEFORE_SHA && process.env.CI_COMMIT_BEFORE_SHA !== zero
      ? process.env.CI_COMMIT_BEFORE_SHA
      : null);
  return base && head ? `${base}..${head}` : null;
}

async function fetchPreviousCandidate() {
  const local = process.env.ORBIT_LAUNCH_TIMING_BASELINE_FILE;
  if (local) {
    try {
      return { report: JSON.parse(readFileSync(local, "utf8")), why: null };
    } catch (error) {
      return { report: null, why: `could not read ${local}: ${error.message}` };
    }
  }

  const api = process.env.CI_API_V4_URL;
  const project = process.env.CI_PROJECT_ID;
  const token = process.env.BASE_REPIN_TOKEN;
  const ref = process.env.ORBIT_LAUNCH_TIMING_REF ?? "preview";
  const job = process.env.ORBIT_LAUNCH_TIMING_JOB ?? "launch_timing";
  if (!api || !project) return { report: null, why: "no API URL or project id in the environment" };
  if (!token) return { report: null, why: "no BASE_REPIN_TOKEN, so the previous run's artefact cannot be read" };

  const path = `web/test-results/launch-timing/${REPORT_NAME}`;
  const url =
    `${api.replace(/\/$/u, "")}/projects/${encodeURIComponent(project)}` +
    `/jobs/artifacts/${encodeURIComponent(ref)}/raw/${path}?job=${encodeURIComponent(job)}`;
  try {
    const response = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    if (!response.ok) return { report: null, why: `${ref} has no readable ${job} report (HTTP ${response.status})` };
    return { report: JSON.parse(await response.text()), why: null };
  } catch (error) {
    return { report: null, why: `could not read the previous report: ${error.message}` };
  }
}

function pad(text, width) {
  return String(text).padEnd(width);
}

/** The two candidates' numbers side by side, one line per pack and phase. */
function printComparison(current, previous) {
  const header = [pad("pack", 12), pad("phase", 8), ...METRICS.map((metric) => pad(metric, 20))].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const [pack, measured] of Object.entries(current.packs)) {
    for (const phase of PHASES) {
      const now = measured[phase] ?? {};
      const then = previous?.packs?.[pack]?.[phase];
      const cells = METRICS.map((metric) => {
        const value = now[metric] ?? 0;
        if (!then) return pad(value, 20);
        const delta = Math.round((value - (then[metric] ?? 0)) * 100) / 100;
        return pad(`${value} (${delta >= 0 ? "+" : ""}${delta})`, 20);
      });
      console.log([pad(pack, 12), pad(phase, 8), ...cells].join(" "));
    }
  }
}

async function main() {
  const directory = process.argv[2];
  if (!directory) {
    console.error("usage: launch-timing-report.mjs <directory>");
    return 2;
  }

  let packs;
  try {
    packs = readPacks(directory);
  } catch (error) {
    console.error(`no launch-timing measurements in ${directory}: ${error.message}`);
    return 1;
  }
  /*
   * The one thing this script does assert. The spec runs and passes on its
   * own; what would go unnoticed is the spec quietly ceasing to write these
   * files -- a rename, a moved output directory -- leaving the promotion gate
   * carrying an empty report forward as if it were a measurement.
   */
  if (Object.keys(packs).length === 0) {
    console.error(`no launch-timing measurements in ${directory}: the spec wrote nothing`);
    return 1;
  }

  const { report: previous, why } = await fetchPreviousCandidate();

  const current = {
    schema: 1,
    commit: process.env.CI_COMMIT_SHA ?? null,
    pipeline: process.env.CI_PIPELINE_URL ?? null,
    ranAt: new Date().toISOString(),
    pipelineRange: pipelineRange(),
    /* The span the comparison below covers, which is what a regression is
       bisected over -- not this pipeline's own diff. */
    sincePreviousCandidate:
      previous?.commit && process.env.CI_COMMIT_SHA ? `${previous.commit}..${process.env.CI_COMMIT_SHA}` : null,
    previousCandidate: previous?.commit ?? null,
    packs,
  };

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, REPORT_NAME), `${JSON.stringify(current, null, 2)}\n`, "utf8");

  if (previous) {
    console.log(`Previous release candidate: ${previous.commit ?? "unknown"} (measured ${previous.ranAt ?? "unknown"})`);
    console.log(`Bisect any regression over:  ${current.sincePreviousCandidate ?? "unknown"}`);
  } else {
    console.log(`No previous release candidate to compare with: ${why}`);
    console.log("This run becomes the baseline the next promotion is read against.");
  }
  console.log("");
  printComparison(current, previous);
  console.log("");
  console.log(
    "Frame intervals in milliseconds. over32 is frames that missed more than one 60fps vsync, over50 three or more.",
  );
  console.log("No verdict is taken from these numbers yet -- see the header of scripts/ci/launch-timing-report.mjs.");
  return 0;
}

process.exitCode = await main();
