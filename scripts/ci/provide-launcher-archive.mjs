#!/usr/bin/env node
// Puts this pipeline's launcher archive in <dir> (#1738 D-S2/D-S4). The archive
// is downloaded from the pipeline's own build job; the build job's artifacts
// expire (3 days off the release refs), and a late retry of
// launcher_install_compat must not depend on them, so an expired archive is
// rebuilt from the pinned source. GitLab fails a job whose `needs:` artifacts
// have expired before its script runs, so the job does not download them by
// needs: it calls this instead.
//
// A rebuilt archive is checked against the signed release manifest's hash for
// it (record_image's artifact, which never expires) when the pipeline has one,
// and the job fails if they differ. Before record_image has run there is no
// manifest yet; record_image then hashes what its own build provides.
//
// Usage: provide-launcher-archive.mjs <dir>
// Environment: CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID, CI_JOB_TOKEN;
//   ORBIT_LAUNCHER_BUILD_SCRIPT (default scripts/ci/build-launcher.sh).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ARCHIVE = "orbit-launcher_linux_amd64.tar.gz";
const MAX_PAGES = 20;

function fail(message) {
  process.stderr.write(`provide-launcher-archive: ${message}\n`);
  process.exit(1);
}

const out = process.argv[2];
if (!out) fail("usage: provide-launcher-archive.mjs <dir>");
const { CI_API_V4_URL: apiBase, CI_PROJECT_ID: projectId, CI_PIPELINE_ID: pipelineId, CI_JOB_TOKEN: token } = process.env;
if (!apiBase || !projectId || !pipelineId || !token) fail("CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID and CI_JOB_TOKEN must be set");
const api = `${apiBase}/projects/${projectId}`;
const headers = { "JOB-TOKEN": token };

async function successfulJobId(names) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetch(`${api}/pipelines/${pipelineId}/jobs?per_page=100&page=${page}`, { headers });
    if (!response.ok) return null;
    const jobs = await response.json();
    if (!Array.isArray(jobs) || jobs.length === 0) return null;
    const found = jobs.find((job) => names.includes(job.name) && job.status === "success");
    if (found) return found.id;
  }
  return null;
}

async function artifact(jobId, path) {
  const response = await fetch(`${api}/jobs/${jobId}/artifacts/${path}`, { headers });
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

mkdirSync(out, { recursive: true });
const target = join(out, ARCHIVE);

const buildJob = await successfulJobId(["build_launcher", "build_launcher_branch"]);
const original = buildJob === null ? null : await artifact(buildJob, `.orbit-launcher-artifacts/${ARCHIVE}`);
if (original !== null) {
  writeFileSync(target, original);
  console.log(`provide-launcher-archive: using the archive built by job ${buildJob}`);
  process.exit(0);
}

console.log("provide-launcher-archive: this pipeline's launcher archive is gone (expired); rebuilding it from the pinned source");
const build = process.env.ORBIT_LAUNCHER_BUILD_SCRIPT || "scripts/ci/build-launcher.sh";
const built = spawnSync("bash", [build, out], { stdio: "inherit" });
if (built.status !== 0) fail(`the rebuild failed (exit ${built.status})`);

const recordJob = await successfulJobId(["record_image"]);
const manifestBytes = recordJob === null ? null : await artifact(recordJob, ".orbit-supply-chain/orbit-release-manifest.json");
if (manifestBytes === null) {
  console.log("provide-launcher-archive: no release manifest in this pipeline yet; record_image will hash the archive it is given");
  process.exit(0);
}
const expected = JSON.parse(manifestBytes.toString("utf8")).files?.[ARCHIVE];
const actual = `sha256:${createHash("sha256").update(readFileSync(target)).digest("hex")}`;
if (expected !== actual) fail(`the rebuilt ${ARCHIVE} (${actual}) differs from the release manifest's (${expected}); not testing a launcher that is not the one shipped`);
console.log("provide-launcher-archive: the rebuilt archive matches the release manifest");
