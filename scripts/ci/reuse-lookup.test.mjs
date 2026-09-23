import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compositeKey } from "./job-inputs.mjs";
import { MAX_EVIDENCE_AGE_MS, MAX_PIPELINES, run } from "./reuse-lookup.mjs";

/*
 * The lookup half of ADR-0028 (#1060 slice 3), against a real HTTP server
 * standing in for GitLab.
 *
 * A fake server rather than a stubbed fetch, because what is being asserted is
 * an exchange -- which pipelines are asked for, in which order, and what a 404
 * on an evidence file means -- and a stub that answers whatever it is asked
 * proves only that the code calls it.
 *
 * Four things are new here over #898, and each has its own group below: the
 * walk goes project-wide rather than down one merge request's pipelines, so a
 * pass on `dev` counts; evidence older than seven days is not believed; a human
 * can turn the whole thing off with a label or a variable; and the six jobs
 * that test the image have their keys finished here, from the content ID, and
 * written out whether or not anything is reused.
 *
 * The reuse verdict can only ever be wrong in two directions, and one of them
 * is expensive while the other ships a stale result. Most of what follows is
 * about the second.
 */

const TOKEN = "TEST-REUSE-TOKEN-NOT-REAL";
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const SOURCE = "e".repeat(64);
const CONTENT_ID = "f".repeat(64);

/* A fixed "now", so the seven-day limit is asserted rather than raced. */
const NOW = Date.parse("2026-09-23T12:00:00Z");
const RECENT = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - MAX_EVIDENCE_AGE_MS - 60_000).toISOString();

let server;
let base;
let seen;

// pipelines: [{ id, jobs: [{ id, name, status, finished_at }] }], newest first.
// evidence: { <job id>: { <job name>: object } }
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

      if (url.startsWith("/api/v4/projects/49/pipelines?")) {
        return send(200, pipelines.map(({ id, ref }) => ({ id, ref: ref ?? "dev" })));
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
let outFile;
const logged = [];

const passed = (id, name, finishedAt = RECENT) => ({ id, name, status: "success", finished_at: finishedAt });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orbit-reuse-"));
  envFile = join(directory, "reuse.env");
  outFile = join(directory, "image.env");
  writeFileSync(envFile, [
    `ORBIT_INPUTS_FAST=${KEY}`,
    `ORBIT_INPUTS_FIDELITY=${KEY}`,
    `ORBIT_SOURCE_SMOKE=${SOURCE}`,
    "",
  ].join("\n"));
  writeFileSync(outFile, "");
  logged.length = 0;
});

function environment(overrides = {}) {
  return {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_PROJECT_ID: "49",
    CI_MERGE_REQUEST_IID: "7",
    CI_PIPELINE_ID: "300",
    ORBIT_REUSE_TOKEN: TOKEN,
    ORBIT_REUSE_API_URL: base,
    ...overrides,
  };
}

const log = (line) => logged.push(String(line));
const emitted = () => readFileSync(envFile, "utf8");
const emittedImage = () => readFileSync(outFile, "utf8");
const lines = () => logged.join("\n");

describe("the source-keyed lookup", () => {
  it("stands on the newest successful run whose evidence names the same key", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [passed(9001, "fast")] }],
      evidence: { 9001: { fast: { job: "fast", inputs: KEY, pipeline: 299, job_id: 9001, stands_on: null } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).toContain("ORBIT_REUSE_FAST=9001");
    expect(emitted()).toContain("ORBIT_REUSE_FAST_PIPELINE=299");
    expect(lines()).toContain("fast: stands on job 9001 from pipeline 299");
  });

  it("sends the token as a header and never in the URL", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [passed(9001, "fast")] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 299, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(seen.tokens.every((value) => value === TOKEN)).toBe(true);
    expect(seen.paths.join("\n")).not.toContain(TOKEN);
  });

  it("does not reuse a run whose key has since changed", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [passed(9001, "fast")] }],
      evidence: { 9001: { fast: { inputs: OTHER_KEY, pipeline: 299, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(lines()).toContain("ran on a different key");
  });

  it("does not reuse a job that did not succeed", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "fast", status: "failed", finished_at: RECENT }] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 299, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(lines()).toContain("fast: runs");
  });

  // A job that gated itself out is green and has no evidence. Green is not the
  // same as "did the work", and this is the only thing that tells them apart.
  it("does not reuse a green job that left no evidence", async () => {
    await start({ pipelines: [{ id: 299, jobs: [passed(9001, "fast")] }] });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
  });

  it("follows a reused run back to the job that really did the work", async () => {
    await start({
      pipelines: [
        { id: 299, jobs: [passed(9100, "fidelity")] },
        { id: 250, jobs: [passed(8000, "fidelity")] },
      ],
      evidence: {
        9100: {
          fidelity: { inputs: KEY, pipeline: 299, job_id: 9100, stands_on: 8000, stands_on_pipeline: 250 },
        },
      },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    // 8000, not 9100: 9100 stood on it, and 8000 is the run that did the work.
    expect(emitted()).toContain("ORBIT_REUSE_FIDELITY=8000");
    expect(emitted()).toContain("ORBIT_REUSE_FIDELITY_PIPELINE=250");
  });

  it("keeps looking through older pipelines for a job the newest one did not run", async () => {
    await start({
      pipelines: [
        { id: 299, jobs: [passed(9100, "fidelity")] },
        { id: 250, jobs: [passed(8000, "fast")] },
      ],
      evidence: { 8000: { fast: { inputs: KEY, pipeline: 250, job_id: 8000 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).toContain("ORBIT_REUSE_FAST=8000");
  });

  it("never looks at the pipeline it is running in", async () => {
    await start({
      pipelines: [{ id: 300, jobs: [passed(9001, "fast")] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 300, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(lines()).toContain("no earlier pipeline");
  });

  it("reuses nothing, and does not throw, when the API cannot be reached", async () => {
    await start();
    const unreachable = `http://127.0.0.1:${server.address().port + 1}/api/v4`;

    await run({ env: environment({ ORBIT_REUSE_API_URL: unreachable }), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_");
    expect(lines()).toContain("could not be listed");
  });
});

describe("the walk goes project-wide", () => {
  // The point of the whole change: the key names content, so a pass on `dev`
  // against the same content is evidence for a merge request that never ran it.
  it("asks for the project's own pipelines, not this merge request's", async () => {
    await start({
      pipelines: [{ id: 299, ref: "dev", jobs: [passed(9001, "fast")] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 299, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(seen.paths[0]).toBe(`/api/v4/projects/49/pipelines?per_page=${MAX_PIPELINES}&order_by=id&sort=desc`);
    expect(seen.paths.join("\n")).not.toContain("merge_requests");
    expect(emitted()).toContain("ORBIT_REUSE_FAST=9001");
  });

  it("looks no further back than twenty pipelines", async () => {
    const pipelines = Array.from({ length: MAX_PIPELINES + 6 }, (unused, index) => ({
      id: 400 - index,
      jobs: index === MAX_PIPELINES + 5 ? [passed(9001, "fast")] : [],
    }));
    await start({
      pipelines,
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 374, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(seen.paths.filter((path) => path.includes("/jobs?")).length).toBe(MAX_PIPELINES);
  });
});

describe("the seven-day limit", () => {
  it("does not reuse a pass older than seven days", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [passed(9001, "fast", STALE)] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 299, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(lines()).toContain("finished too long ago");
    // And never even reads the evidence, so a stale artefact costs no request.
    expect(seen.paths.join("\n")).not.toContain("ci-evidence");
  });

  it("does not reuse a pass whose finish time the API did not report", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [{ id: 9001, name: "fast", status: "success" }] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 299, job_id: 9001 } } },
    });

    await run({ env: environment(), envFile, now: NOW, log });

    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(lines()).toContain("no finish time");
  });
});

describe("the escape hatches", () => {
  async function withOnePass() {
    await start({
      pipelines: [{ id: 299, jobs: [passed(9001, "fast")] }],
      evidence: { 9001: { fast: { inputs: KEY, pipeline: 299, job_id: 9001 } } },
    });
  }

  it("asks nothing when the merge request is labelled 'ci: rerun'", async () => {
    await withOnePass();

    await run({ env: environment({ CI_MERGE_REQUEST_LABELS: "type: chore,ci: rerun" }), envFile, now: NOW, log });

    expect(seen.paths).toEqual([]);
    expect(emitted()).not.toContain("ORBIT_REUSE_FAST");
    expect(lines()).toContain("ci: rerun");
  });

  it("is not turned off by some other label", async () => {
    await withOnePass();

    await run({ env: environment({ CI_MERGE_REQUEST_LABELS: "ci: acceptance" }), envFile, now: NOW, log });

    expect(emitted()).toContain("ORBIT_REUSE_FAST=9001");
  });

  it("asks nothing when ORBIT_REUSE is off", async () => {
    await withOnePass();

    await run({ env: environment({ ORBIT_REUSE: "off" }), envFile, now: NOW, log });

    expect(seen.paths).toEqual([]);
    expect(lines()).toContain("ORBIT_REUSE=off");
  });

  it("asks nothing at all when there is no token", async () => {
    await withOnePass();

    await run({ env: environment({ ORBIT_REUSE_TOKEN: "" }), envFile, now: NOW, log });

    expect(seen.paths).toEqual([]);
    expect(emitted()).not.toContain("ORBIT_REUSE_");
    expect(lines()).toContain("ORBIT_REUSE_TOKEN");
  });

  // What #898 used. It is protected since #1084, so it is present only on the
  // delivery refs that never consume evidence -- kept so nothing breaks if the
  // owner points a read-only credential at the same name.
  it("still accepts BASE_REPIN_TOKEN when ORBIT_REUSE_TOKEN is unset", async () => {
    await withOnePass();

    await run({
      env: environment({ ORBIT_REUSE_TOKEN: "", BASE_REPIN_TOKEN: TOKEN }), envFile, now: NOW, log,
    });

    expect(emitted()).toContain("ORBIT_REUSE_FAST=9001");
  });

  // ADR-0028 section 2: delivery branches never consume evidence; they record it.
  it("reuses nothing outside a merge request", async () => {
    await withOnePass();

    await run({ env: environment({ CI_PIPELINE_SOURCE: "push" }), envFile, now: NOW, log });

    expect(seen.paths).toEqual([]);
    expect(emitted()).not.toContain("ORBIT_REUSE_");
  });
});

describe("the image jobs' keys", () => {
  const environmentWithImage = (overrides = {}) =>
    environment({ ORBIT_IMAGE_CONTENT_ID: CONTENT_ID, ...overrides });
  const smokeKey = () => compositeKey("smoke", SOURCE, CONTENT_ID);

  it("finishes each key from the source key and the image content ID", async () => {
    await start({ pipelines: [] });

    await run({ env: environmentWithImage(), envFile, artefact: "image", outFile, now: NOW, log });

    expect(emittedImage()).toContain(`ORBIT_INPUTS_SMOKE=${smokeKey()}`);
    // classify's own file is left alone: the two are separate artefacts.
    expect(emitted()).not.toContain("ORBIT_INPUTS_SMOKE");
  });

  it("stands on a run whose evidence names that finished key", async () => {
    await start({
      pipelines: [{ id: 299, ref: "dev", jobs: [passed(9001, "smoke")] }],
      evidence: { 9001: { smoke: { inputs: compositeKey("smoke", SOURCE, CONTENT_ID), job_id: 9001 } } },
    });

    await run({ env: environmentWithImage(), envFile, artefact: "image", outFile, now: NOW, log });

    expect(emittedImage()).toContain("ORBIT_REUSE_SMOKE=9001");
  });

  // A different image is a different thing under test, whatever the checkout
  // says. This is the axis the deny-list for src/** and web/** rests on.
  it("does not stand on a run of the same source against another image", async () => {
    await start({
      pipelines: [{ id: 299, jobs: [passed(9001, "smoke")] }],
      evidence: { 9001: { smoke: { inputs: compositeKey("smoke", SOURCE, "another-content-id"), job_id: 9001 } } },
    });

    await run({ env: environmentWithImage(), envFile, artefact: "image", outFile, now: NOW, log });

    expect(emittedImage()).not.toContain("ORBIT_REUSE_SMOKE");
  });

  // Delivery pipelines are where the evidence the merge requests stand on comes
  // from, so the keys have to be written even where nothing is looked up.
  it("writes the keys on a delivery pipeline, which consumes nothing", async () => {
    await start({ pipelines: [{ id: 299, jobs: [passed(9001, "smoke")] }] });

    await run({
      env: environmentWithImage({ CI_PIPELINE_SOURCE: "push" }), envFile, artefact: "image", outFile, now: NOW, log,
    });

    expect(emittedImage()).toContain(`ORBIT_INPUTS_SMOKE=${smokeKey()}`);
    expect(emittedImage()).not.toContain("ORBIT_REUSE_SMOKE");
    expect(seen.paths).toEqual([]);
  });

  it("writes the keys, and reuses nothing, when the lookup is turned off", async () => {
    await start({ pipelines: [] });

    await run({
      env: environmentWithImage({ ORBIT_REUSE: "off" }), envFile, artefact: "image", outFile, now: NOW, log,
    });

    expect(emittedImage()).toContain(`ORBIT_INPUTS_SMOKE=${smokeKey()}`);
  });

  // No content ID means no artefact axis, so there is no key any of the six can
  // be compared on -- and no evidence worth recording either.
  it("writes no key at all when the content ID is missing", async () => {
    await start({ pipelines: [] });

    await run({ env: environment(), envFile, artefact: "image", outFile, now: NOW, log });

    expect(emittedImage()).toBe("");
    expect(lines()).toContain("ORBIT_IMAGE_CONTENT_ID is unset");
  });

  it("leaves a job out when classify published no source key for it", async () => {
    writeFileSync(envFile, `ORBIT_INPUTS_FAST=${KEY}\n`);
    await start({ pipelines: [] });

    await run({ env: environmentWithImage(), envFile, artefact: "image", outFile, now: NOW, log });

    expect(emittedImage()).toBe("");
    expect(lines()).toContain("smoke: classify published no source key");
  });
});
