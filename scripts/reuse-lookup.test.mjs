import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "./ci/reuse-lookup.mjs";

/*
 * The lookup half of #898, against a real HTTP server standing in for GitLab.
 *
 * A fake server rather than a stubbed fetch, because what is being asserted is
 * an exchange -- which pipelines are asked for, in which order, and what a 404
 * on an evidence file means -- and a stub that answers whatever it is asked
 * proves only that the code calls it.
 *
 * The reuse verdict can only ever be wrong in two directions, and one of them
 * is expensive while the other ships a stale result. Every test below is about
 * the second: hashes that do not match, a job that did not succeed, evidence
 * that is missing, and a chain of reuses that has to lead back to the run that
 * really did the work.
 */

const TOKEN = "TEST-REUSE-TOKEN-NOT-REAL";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

let server;
let base;
let seen;

// pipelines: [{ id, jobs: [{ id, name, status }] }], newest first.
// evidence: { <job id>: { <job name>: object | "missing" } }
function start({ pipelines = [], evidence = {} } = {}) {
  seen = { paths: [], tokens: [] };
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      seen.paths.push(request.url);
      seen.tokens.push(request.headers["private-token"]);
      const url = request.url;
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };

      if (url === "/api/v4/projects/49/merge_requests/7/pipelines") {
        return send(200, pipelines.map(({ id }) => ({ id })));
      }
      const jobsMatch = url.match(/^\/api\/v4\/projects\/49\/pipelines\/(\d+)\/jobs\?per_page=100$/u);
      if (jobsMatch) {
        const pipeline = pipelines.find((entry) => entry.id === Number(jobsMatch[1]));
        return send(200, pipeline ? pipeline.jobs : []);
      }
      const artifactMatch = url.match(/^\/api\/v4\/projects\/49\/jobs\/(\d+)\/artifacts\/ci-evidence\/(.+)\.json$/u);
      if (artifactMatch) {
        const found = evidence[artifactMatch[1]]?.[artifactMatch[2]];
        if (!found) return send(404, { message: "404 Not Found" });
        return send(200, found);
      }
      return send(404, { message: "404 Not Found" });
    });
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}/api/v4`;
      resolve();
    });
  });
}

afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

let directory;
let envFile;
const logged = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orbit-reuse-"));
  envFile = join(directory, "reuse.env");
  writeFileSync(envFile, `ORBIT_INPUTS_SMOKE=${HASH}\nORBIT_INPUTS_BUILD_IMAGE=${HASH}\n`);
  logged.length = 0;
});

function environment(overrides = {}) {
  return {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_PROJECT_ID: "49",
    CI_MERGE_REQUEST_IID: "7",
    CI_PIPELINE_ID: "300",
    BASE_REPIN_TOKEN: TOKEN,
    ORBIT_REUSE_API_URL: base,
    ...overrides,
  };
}

const log = (line) => logged.push(String(line));
const emitted = () => readFileSync(envFile, "utf8");

describe("reuse lookup", () => {
  it("stands on the newest successful run whose evidence names the same inputs", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "success" }] }],
      evidence: { 9001: { smoke: { job: "smoke", inputs: HASH, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment(), envFile, log });

    expect(emitted()).toContain("ORBIT_REUSE_SMOKE=9001");
    expect(emitted()).toContain("ORBIT_REUSE_SMOKE_PIPELINE=299");
    expect(logged.join("\n")).toContain("smoke: stands on job 9001 from pipeline 299");
  });

  it("sends the token as a header and never in the URL", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "success" }] }],
      evidence: { 9001: { smoke: { inputs: HASH, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment(), envFile, log });

    expect(seen.tokens.every((value) => value === TOKEN)).toBe(true);
    expect(seen.paths.join("\n")).not.toContain(TOKEN);
  });

  it("does not reuse a run whose inputs have since changed", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "success" }] }],
      evidence: { 9001: { smoke: { inputs: OTHER_HASH, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment(), envFile, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_SMOKE");
    expect(logged.join("\n")).toContain("ran on different inputs");
  });

  it("does not reuse a job that did not succeed", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "failed" }] }],
      evidence: { 9001: { smoke: { inputs: HASH, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment(), envFile, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_SMOKE");
    expect(logged.join("\n")).toContain("smoke: runs");
  });

  // A job that gated itself out is green and has no evidence. Green is not the
  // same as "did the work", and this is the only thing that tells them apart.
  it("does not reuse a green job that left no evidence", async () => {
    await start({ pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "success" }] }] });

    await run({ env: environment(), envFile, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_SMOKE");
  });

  it("follows a reused run back to the job that really did the work", async () => {
    await start({
      pipelines: [
        { id: 299, jobs: [{ id: 9100, name: "build_image", status: "success" }] },
        { id: 250, jobs: [{ id: 8000, name: "build_image", status: "success" }] },
      ],
      evidence: {
        9100: {
          build_image: {
            inputs: HASH, pipeline: 299, job_id: 9100, stands_on: 8000, stands_on_pipeline: 250,
          },
        },
      },
    });

    await run({ env: environment(), envFile, log });

    // 8000, not 9100: 9100 stood on it, and it is 8000 that holds the image.
    expect(emitted()).toContain("ORBIT_REUSE_BUILD_IMAGE=8000");
    expect(emitted()).toContain("ORBIT_REUSE_BUILD_IMAGE_PIPELINE=250");
  });

  it("keeps looking through older pipelines for a job the newest one did not run", async () => {
    await start({
      pipelines: [
        { id: 299, jobs: [{ id: 9100, name: "fast", status: "success" }] },
        { id: 250, jobs: [{ id: 8000, name: "smoke", status: "success" }] },
      ],
      evidence: { 8000: { smoke: { inputs: HASH, pipeline: 250, job_id: 8000, stands_on: null } } },
    });

    await run({ env: environment(), envFile, log });

    expect(emitted()).toContain("ORBIT_REUSE_SMOKE=8000");
  });

  it("never looks at the pipeline it is running in", async () => {
    await start({
      pipelines: [{ id: 300, jobs: [{ id: 9001, name: "smoke", status: "success" }] }],
      evidence: { 9001: { smoke: { inputs: HASH, pipeline: 300, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment(), envFile, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_SMOKE");
    expect(logged.join("\n")).toContain("no earlier pipeline");
  });

  it("asks nothing at all when the token is unset", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "success" }] }],
      evidence: { 9001: { smoke: { inputs: HASH, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment({ BASE_REPIN_TOKEN: "" }), envFile, log });

    expect(seen.paths).toEqual([]);
    expect(emitted()).not.toContain("ORBIT_REUSE_");
    expect(logged.join("\n")).toContain("BASE_REPIN_TOKEN is unset");
  });

  // Criterion 3: a pipeline on dev, preview, main or a hotfix branch is the
  // delivery gate and pays for the whole diff, every time.
  it("reuses nothing outside a merge request", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "smoke", status: "success" }] }],
      evidence: { 9001: { smoke: { inputs: HASH, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment({ CI_PIPELINE_SOURCE: "push" }), envFile, log });

    expect(seen.paths).toEqual([]);
    expect(emitted()).not.toContain("ORBIT_REUSE_");
  });

  it("reuses nothing, and does not throw, when the API cannot be reached", async () => {
    await start();
    const unreachable = `http://127.0.0.1:${server.address().port + 1}/api/v4`;

    await run({ env: environment({ ORBIT_REUSE_API_URL: unreachable }), envFile, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_");
    expect(logged.join("\n")).toContain("could not be listed");
  });
});
