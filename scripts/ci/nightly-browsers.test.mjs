import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  ISSUE_TITLE,
  MAX_TEST_LINES,
  failingTests,
  main,
  nearestMilestone,
} from "./nightly-browsers.mjs";

/*
 * The nightly browser run's two questions (#1412), against a real HTTP
 * server standing in for GitLab: has dev moved since the last nightly, and
 * file the failure once.
 *
 * `moved` must only ever err toward running; `report` must file one issue,
 * not one a night. Most of what follows is about those two directions.
 */

const TOKEN = "TEST-NIGHTLY-TOKEN-NOT-REAL";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

let server;
let seen;

// pipelines: [{ id, sha, status, ref, source, jobs: [name] }], newest first.
function start({ pipelines = [], issues = [], milestones = [], failedJobs = [], traces = {}, fail = {}, failStatusLookup = false } = {}) {
  seen = { requests: [], tokens: [], created: null, noted: null };
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url, "http://localhost");
        seen.requests.push(`${request.method} ${url.pathname}${url.search}`);
        seen.tokens.push(request.headers["private-token"]);
        const send = (status, body) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        const path = url.pathname.replace("/api/v4/projects/49", "");
        for (const [prefix, status] of Object.entries(fail)) {
          if (path.startsWith(prefix)) return send(status, { message: "boom" });
        }
        if (request.method === "GET" && path === "/pipelines") {
          const sha = url.searchParams.get("sha");
          const ref = url.searchParams.get("ref");
          const status = url.searchParams.get("status");
          const source = url.searchParams.get("source");
          if (status && failStatusLookup) return send(500, { message: "boom" });
          return send(
            200,
            pipelines
              .filter((pipeline) => (source ? source === (pipeline.source ?? "schedule") : true))
              .filter((pipeline) => (status ? pipeline.status === status : true))
              .filter((pipeline) => (sha ? pipeline.sha === sha : ref ? (pipeline.ref ?? "dev") === ref : true))
              .map(({ id, sha: pipelineSha, status, ref: pipelineRef }) => ({
                id,
                sha: pipelineSha,
                status,
                ref: pipelineRef ?? "dev",
                web_url: `https://gitlab.example.test/ai/orbit/-/pipelines/${id}`,
              })),
          );
        }
        const jobs = path.match(/^\/pipelines\/(\d+)\/jobs$/u);
        if (jobs && request.method === "GET") {
          if (url.searchParams.get("scope[]") === "failed") return send(200, failedJobs);
          const pipeline = pipelines.find((entry) => entry.id === Number(jobs[1]));
          return send(200, (pipeline?.jobs ?? ["classify"]).map((name) => ({ name })));
        }
        const trace = path.match(/^\/jobs\/(\d+)\/trace$/u);
        if (trace) return send(200, traces[trace[1]] ?? "");
        if (request.method === "GET" && path === "/issues") return send(200, issues);
        if (request.method === "GET" && path === "/milestones") return send(200, milestones);
        const note = path.match(/^\/issues\/(\d+)\/notes$/u);
        if (note && request.method === "POST") {
          seen.noted = { iid: Number(note[1]), ...JSON.parse(Buffer.concat(chunks).toString()) };
          return send(201, { id: 1 });
        }
        if (request.method === "POST" && path === "/issues") {
          seen.created = JSON.parse(Buffer.concat(chunks).toString());
          return send(201, { iid: 77 });
        }
        return send(404, { message: "404 Not Found" });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/api/v4`));
  });
}

afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

async function run(argv, env) {
  const out = [];
  const err = [];
  const code = await main(argv, env, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const base = (api) => ({
  ORBIT_NIGHTLY_API_URL: api,
  CI_PROJECT_ID: "49",
  CI_PIPELINE_ID: "100",
  CI_PIPELINE_URL: "https://gitlab.example.test/ai/orbit/-/pipelines/100",
  CI_COMMIT_SHA: SHA,
  ORBIT_REUSE_TOKEN: TOKEN,
});

describe("moved", () => {
  it("is idle when the last nightly ran on this very commit", async () => {
    const api = await start({ pipelines: [{ id: 90, sha: SHA, status: "success" }] });
    const result = await run(["moved"], base(api));
    expect(result).toMatchObject({ code: 0, out: "idle" });
    expect(seen.tokens.every((token) => token === TOKEN)).toBe(true);
  });

  it("runs when dev has moved, when no nightly has run, and when the last one failed on an older commit", async () => {
    for (const pipelines of [
      [{ id: 90, sha: OTHER_SHA, status: "success" }],
      [],
      [{ id: 90, sha: OTHER_SHA, status: "failed" }],
    ]) {
      const api = await start({ pipelines });
      expect((await run(["moved"], base(api))).out).toBe("run");
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
  });

  it("skips another schedule's pipeline: one with no classify job is not a nightly", async () => {
    const api = await start({
      pipelines: [
        { id: 95, sha: SHA, status: "success", jobs: ["renovate"] },
        { id: 90, sha: OTHER_SHA, status: "success" },
      ],
    });
    expect((await run(["moved"], base(api))).out).toBe("run");
  });

  it("ignores its own pipeline and a cancelled one", async () => {
    const api = await start({
      pipelines: [
        { id: 100, sha: SHA, status: "running" },
        { id: 99, sha: SHA, status: "canceled" },
        { id: 90, sha: OTHER_SHA, status: "success" },
      ],
    });
    expect((await run(["moved"], base(api))).out).toBe("run");
  });

  it("only looks at dev's schedule pipelines", async () => {
    const api = await start({ pipelines: [{ id: 90, sha: SHA, status: "success", ref: "other" }] });
    expect((await run(["moved"], base(api))).out).toBe("run");
    // The yield check's four preview/main requests come first (#1546); the
    // nightly lookup is the one that names the schedule.
    const nightlyLookup = seen.requests.find((request) => request.includes("source=schedule"));
    expect(nightlyLookup).toContain("ref=dev");
  });

  it("runs, and exits 0, when GitLab cannot be asked or does not answer", async () => {
    const api = await start({ fail: { "/pipelines": 500 } });
    expect(await run(["moved"], base(api))).toMatchObject({ code: 0, out: "run" });
    const noToken = { ...base(api), ORBIT_REUSE_TOKEN: "" };
    expect(await run(["moved"], noToken)).toMatchObject({ code: 0, out: "run" });
    expect((await run(["moved"], noToken)).err).toMatch(/token unknown\): running/u);
  });
});

// #1546 (the nightly yields to a promotion): a running or pending pipeline on
// preview or main means a promotion is under way, so the nightly steps aside.
describe("moved yields to a promotion", () => {
  it("yields to a running preview pipeline, names it, and never looks at the nightlies", async () => {
    const api = await start({
      pipelines: [
        { id: 3200, sha: OTHER_SHA, status: "running", ref: "preview", source: "push" },
        { id: 90, sha: SHA, status: "success" },
      ],
    });
    const result = await run(["moved"], base(api));
    expect(result.out).toBe("yield");
    expect(result.err).toMatch(/pipeline 3200/u);
    expect(result.err).toContain("preview");
    expect(seen.requests.some((request) => request.includes("source=schedule"))).toBe(false);
  });

  it("asks for running and pending pipelines on both preview and main", async () => {
    const api = await start({ pipelines: [{ id: 90, sha: SHA, status: "success" }] });
    await run(["moved"], base(api));
    for (const ref of ["preview", "main"]) {
      for (const status of ["running", "pending"]) {
        expect(seen.requests).toContain(`GET /api/v4/projects/49/pipelines?ref=${ref}&status=${status}`);
      }
    }
  });

  it("yields to a pending main pipeline", async () => {
    const api = await start({
      pipelines: [{ id: 3300, sha: OTHER_SHA, status: "pending", ref: "main", source: "push" }],
    });
    expect((await run(["moved"], base(api))).out).toBe("yield");
  });

  it("does not yield to its own pipeline: the nightly lookup runs as today", async () => {
    const api = await start({
      pipelines: [
        { id: 100, sha: SHA, status: "running", ref: "preview", source: "push" },
        { id: 90, sha: SHA, status: "success" },
      ],
    });
    const result = await run(["moved"], base(api));
    expect(result.out).toBe("idle");
    expect(seen.requests.some((request) => request.includes("source=schedule"))).toBe(true);
  });

  it("does not yield to a finished preview pipeline", async () => {
    const api = await start({
      pipelines: [{ id: 3200, sha: OTHER_SHA, status: "success", ref: "preview", source: "push" }],
    });
    expect((await run(["moved"], base(api))).out).toBe("run");
  });

  it("goes on to the nightly lookup when the yield lookup answers 500", async () => {
    for (const [pipelines, expected] of [
      [[{ id: 90, sha: SHA, status: "success" }], "idle"],
      [[{ id: 90, sha: OTHER_SHA, status: "success" }], "run"],
    ]) {
      const api = await start({ pipelines, failStatusLookup: true });
      const result = await run(["moved"], base(api));
      expect(result).toMatchObject({ code: 0, out: expected });
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
  });

  it("prints yield through the CLI, on its own line, like idle and run", async () => {
    const api = await start({
      pipelines: [{ id: 3200, sha: OTHER_SHA, status: "running", ref: "preview", source: "push" }],
    });
    expect(await run(["moved"], base(api))).toMatchObject({ code: 0, out: "yield" });
  });
});

// #1544 (owner decision 5a): promotion no longer waits on a nightly, so the
// script has no `blocked` mode. It is an unknown command: exit non-zero and
// print the usage line, which lists `moved` and `report` only.
describe("blocked (removed)", () => {
  it("is refused as an unknown command, with a usage line listing only moved | report", async () => {
    const api = await start({ pipelines: [{ id: 90, sha: SHA, status: "failed" }] });
    const result = await run(["blocked"], base(api));
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("usage: nightly-browsers.mjs moved | report");
    expect(result.err).not.toMatch(/blocked/u);
    expect(seen.requests).toEqual([]);
  });
});

describe("report", () => {
  const failedJobs = [
    { id: 11, name: "smoke_webkit", failure_reason: "script_failure", web_url: "https://gitlab.example.test/job/11", allow_failure: false },
    { id: 12, name: "smoke_local_only", failure_reason: "script_failure", web_url: "https://gitlab.example.test/job/12", allow_failure: true },
  ];
  const traces = {
    11: "\u001b[31m  1) [desktop-webkit] › tests/e2e/a.spec.ts:3:1 › opens the door\u001b[39m\nnoise\n  2) [mobile-webkit] › b.spec.ts:9:1 › closes it\n",
  };
  const withIssueToken = (api) => ({ ...base(api), SIDECAR_ISSUE_TOKEN: TOKEN });

  it("files one issue in the nearest open milestone, listing the failed jobs and tests", async () => {
    const api = await start({
      failedJobs,
      traces,
      milestones: [
        { id: 3, title: "M9 — Later" },
        { id: 2, title: "M5 — Supply chain" },
        { id: 8, title: "Backlog" },
      ],
    });
    const result = await run(["report"], withIssueToken(api));
    expect(result.code).toBe(0);
    expect(seen.created.title).toBe(ISSUE_TITLE);
    expect(seen.created.milestone_id).toBe(2);
    expect(seen.created.description).toContain("`smoke_webkit`");
    expect(seen.created.description).toContain("[desktop-webkit] › tests/e2e/a.spec.ts:3:1 › opens the door");
    expect(seen.created.description).toContain("[mobile-webkit] › b.spec.ts:9:1 › closes it");
    // An allowed failure is not the night's failure.
    expect(seen.created.description).not.toContain("smoke_local_only");
    expect(seen.created.description).not.toContain("\u001b");
    expect(seen.noted).toBeNull();
  });

  it("comments on the open issue instead of filing a second one", async () => {
    const api = await start({
      failedJobs,
      traces,
      issues: [
        { iid: 5, title: "Something else" },
        { iid: 6, title: ISSUE_TITLE },
      ],
    });
    const result = await run(["report"], withIssueToken(api));
    expect(result.code).toBe(0);
    expect(seen.created).toBeNull();
    expect(seen.noted.iid).toBe(6);
    expect(seen.noted.body).toContain("`smoke_webkit`");
  });

  it("still files, without a milestone, when none is open", async () => {
    const api = await start({ failedJobs, milestones: [] });
    expect((await run(["report"], withIssueToken(api))).code).toBe(0);
    expect(seen.created).not.toHaveProperty("milestone_id");
  });

  it("fails clearly, naming the variable, when SIDECAR_ISSUE_TOKEN is unset", async () => {
    const api = await start({ failedJobs });
    const result = await run(["report"], base(api));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/SIDECAR_ISSUE_TOKEN is not set/u);
    expect(seen.requests).toEqual([]);
  });

  it("fails when GitLab refuses the filing, so the night is not quietly lost", async () => {
    const api = await start({ failedJobs, fail: { "/issues": 403 } });
    const result = await run(["report"], withIssueToken(api));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/could not file the issue/u);
    expect(result.err).not.toContain(TOKEN);
  });
});

describe("helpers", () => {
  it("quotes failing tests only, without colour, once each and no more than the cap", () => {
    const lines = Array.from({ length: MAX_TEST_LINES + 5 }, (_, index) => `  ${index + 1}) [desktop-chromium] › t.spec.ts › test ${index}`);
    const found = failingTests(`ok line\n${lines.join("\n")}\n${lines[0]}\n FAIL  src/x.test.ts > y\n`);
    expect(found).toHaveLength(MAX_TEST_LINES);
    expect(new Set(found).size).toBe(found.length);
    expect(failingTests("all green")).toEqual([]);
  });

  it("picks the lowest-numbered milestone and ignores unnumbered ones", () => {
    expect(nearestMilestone([{ id: 1, title: "M10 — x" }, { id: 2, title: "M2 — y" }, { id: 3, title: "Misc" }])).toMatchObject({ id: 2 });
    expect(nearestMilestone([{ id: 3, title: "Misc" }])).toBeNull();
    expect(nearestMilestone(undefined)).toBeNull();
  });

  it("refuses an unknown command", async () => {
    expect((await run(["frobnicate"], {})).code).toBe(2);
  });
});
