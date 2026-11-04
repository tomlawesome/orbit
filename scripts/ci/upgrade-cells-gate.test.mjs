import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run } from "./upgrade-cells-gate.mjs";

/*
 * The re-run check for the upgrade cells (#1665, owner answer 60a), from the
 * specification note on the issue.
 *
 * On a dev -> preview merge request the cells run on the first pipeline and
 * after that only when a commit touches something an update depends on, since
 * the last commit whose cells passed. The same shape as the reuse lookup
 * (ADR-0028): skip only when a passing run covers the content, and run on any
 * doubt.
 *
 * A fake fetch stands in for GitLab and a real temporary git repository stands
 * in for the checkout, so `git diff` really runs. The repository has no
 * remote, so a base commit that is not in it cannot be fetched either.
 */

const TOKEN = "TEST-GATE-TOKEN-NOT-REAL";
const API = "https://gitlab.example.test/api/v4";
const PROJECT = "49";
const MR = "7";
const CURRENT = 300;

let directory;
let repo;
let outFile;
let calls;
const logged = [];

const log = (line) => logged.push(String(line));
const lines = () => logged.join("\n");
const written = () => readFileSync(outFile, "utf8");

function git(...args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  }).trim();
}

// Commit the given files (path -> content) and return the new sha.
function commit(files, message = "change") {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

let counter = 0;
const touch = (path) => commit({ [path]: `change ${(counter += 1)}\n` }, `touch ${path}`);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orbit-upgrade-gate-"));
  repo = join(directory, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "work");
  commit({ "README.md": "base\n" }, "base");
  outFile = join(directory, "gate.env");
  calls = [];
  logged.length = 0;
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

const ok = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const fail = (status) => ({
  ok: false,
  status,
  json: async () => ({ message: `${status}` }),
  text: async () => `${status}`,
});

/*
 * pipelines: [{ id, sha, jobs: [{ id, name, status }], gate }], newest first.
 * gate is the text of the classify job's .orbit-upgrade/gate.env, or undefined
 * for "no such artefact" (404).
 * A job named "classify" is added to each pipeline with id pipeline*10.
 */
function fakeFetch({ pipelines = [], mrPipelinesStatus = 200, jobsStatus = 200 } = {}) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers ?? {} });
    const { pathname } = new URL(String(url));
    const path = pathname.replace(/^\/api\/v4\//u, "");

    if (path === `projects/${PROJECT}/merge_requests/${MR}/pipelines`) {
      if (mrPipelinesStatus !== 200) return fail(mrPipelinesStatus);
      return ok(pipelines.map(({ id, sha }) => ({ id, sha })));
    }
    const jobsMatch = path.match(/^projects\/49\/pipelines\/(\d+)\/jobs$/u);
    if (jobsMatch) {
      if (jobsStatus !== 200) return fail(jobsStatus);
      const pipeline = pipelines.find((entry) => entry.id === Number(jobsMatch[1]));
      if (!pipeline) return ok([]);
      return ok([{ id: pipeline.id * 10, name: "classify", status: "success" }, ...pipeline.jobs]);
    }
    const artefactMatch = path.match(/^projects\/49\/jobs\/(\d+)\/artifacts\/\.orbit-upgrade\/gate\.env$/u);
    if (artefactMatch) {
      const pipeline = pipelines.find((entry) => entry.id * 10 === Number(artefactMatch[1]));
      if (!pipeline || pipeline.gate === undefined) return fail(404);
      return ok(pipeline.gate);
    }
    return fail(404);
  };
}

const cell = (status, name = "upgrade_cell", id = 1) => ({ id, name, status });
const gateRun = "UPGRADE_CELLS=run\n";
const gateSkip = (since) => `UPGRADE_CELLS=skip\nUPGRADE_CELLS_SINCE=${since}\n`;

function environment(overrides = {}) {
  return {
    CI_PIPELINE_SOURCE: "merge_request_event",
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "preview",
    CI_MERGE_REQUEST_IID: MR,
    CI_PROJECT_ID: PROJECT,
    CI_API_V4_URL: API,
    CI_PIPELINE_ID: String(CURRENT),
    CI_COMMIT_SHA: git("rev-parse", "HEAD"),
    ORBIT_REUSE_TOKEN: TOKEN,
    ...overrides,
  };
}

async function gate({ env = {}, fetchImpl } = {}) {
  return run({
    env: environment(env),
    argv: [outFile],
    fetchImpl,
    cwd: repo,
    log,
  });
}

// One earlier pipeline on `sha` whose cells passed and which ran for real.
const passedRun = (sha, id = 299, gate = gateRun) => ({ id, sha, jobs: [cell("success")], gate });

function expectRun(result) {
  expect(result.decision).toBe("run");
  expect(written()).toContain("UPGRADE_CELLS=run");
  expect(written()).not.toContain("UPGRADE_CELLS=skip");
  expect(written()).not.toContain("UPGRADE_CELLS_SINCE");
  expect(logged.length).toBeGreaterThan(0);
}

function expectNoTokenAnywhere() {
  expect(lines()).not.toContain(TOKEN);
  expect(written()).not.toContain(TOKEN);
  expect(calls.map((call) => call.url).join("\n")).not.toContain(TOKEN);
}

describe("the first pipeline of the merge request", () => {
  it("writes run when the merge request has no earlier pipeline", async () => {
    const result = await gate({ fetchImpl: fakeFetch({ pipelines: [] }) });

    expectRun(result);
  });

  it("writes run when the only earlier pipeline is the current one", async () => {
    const sha = git("rev-parse", "HEAD");
    const result = await gate({
      fetchImpl: fakeFetch({ pipelines: [passedRun(sha, CURRENT)] }),
    });

    expectRun(result);
  });

  it("writes run when no earlier pipeline has passed cells", async () => {
    const sha = git("rev-parse", "HEAD");
    touch("src/a.test.ts");
    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [
          { id: 299, sha, jobs: [], gate: gateRun },
          { id: 298, sha, jobs: [cell("failed")], gate: gateRun },
        ],
      }),
    });

    expectRun(result);
  });

  it("creates the output file's directory when it does not exist", async () => {
    outFile = join(directory, ".orbit-upgrade", "gate.env");

    await gate({ fetchImpl: fakeFetch({ pipelines: [] }) });

    expect(written()).toContain("UPGRADE_CELLS=run");
  });
});

describe("a change to something updates depend on, after a passed run", () => {
  // One representative file per group in the specification, plus the matrix.
  it.each([
    ["the installer scripts", "scripts/install.sh"],
    ["the installer scripts", "scripts/update-and-start.sh"],
    ["the compose files at the root", "docker-compose.mail.yml"],
    ["the compose directory", "compose/x.yml"],
    ["database migrations", "drizzle/0001_x.sql"],
    ["the env template", ".env-orbit.example"],
    ["the settings directory", "config/tika-config.json"],
    ["the matrix itself", "scripts/ci/upgrade-cell.sh"],
    ["the matrix's manifest writer", "scripts/ci/write-test-manifest.sh"],
    ["this script", "scripts/ci/upgrade-cells-gate.mjs"],
  ])("writes run for %s (%s)", async (unused, path) => {
    const base = git("rev-parse", "HEAD");
    touch(path);

    const result = await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expectRun(result);
  });

  it("writes run when an update-relevant change sits among test-only ones", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");
    touch("drizzle/0002_y.sql");
    touch("docs/notes.md");

    const result = await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expectRun(result);
  });
});

describe("a change to nothing updates depend on, after a passed run", () => {
  it("writes skip with the base sha for a test-only change", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/widget.test.ts");

    const result = await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expect(result).toEqual({ decision: "skip", since: base });
    expect(written()).toContain("UPGRADE_CELLS=skip");
    expect(written()).toContain(`UPGRADE_CELLS_SINCE=${base}`);
  });

  it("prints the sha it relies on", async () => {
    const base = git("rev-parse", "HEAD");
    touch("docs/notes.md");

    await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expect(lines()).toContain(base);
  });

  it("does not treat near-miss paths as update-relevant", async () => {
    const base = git("rev-parse", "HEAD");
    touch("scripts/ci/reuse-lookup.mjs");
    touch("scripts/other.sh");
    touch("web/config/page.ts");
    touch("src/compose/notes.md");

    const result = await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expect(result).toEqual({ decision: "skip", since: base });
  });

  it("writes skip when nothing at all changed since the base", async () => {
    const base = git("rev-parse", "HEAD");

    const result = await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expect(result).toEqual({ decision: "skip", since: base });
  });
});

describe("a chain of skips", () => {
  it("keeps the sha of the original real run, not the skipping pipeline's", async () => {
    const realRun = git("rev-parse", "HEAD");
    const skipped = touch("src/a.test.ts");
    touch("src/b.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [
          // The newest pipeline skipped: its cells exited 0 and count as passed.
          { id: 299, sha: skipped, jobs: [cell("success")], gate: gateSkip(realRun) },
        ],
      }),
    });

    expect(result).toEqual({ decision: "skip", since: realRun });
    expect(written()).toContain(`UPGRADE_CELLS_SINCE=${realRun}`);
    expect(written()).not.toContain(skipped);
    expect(lines()).toContain(realRun);
  });

  it("writes run when an update-relevant change came after the original run", async () => {
    const realRun = git("rev-parse", "HEAD");
    const skipped = touch("src/a.test.ts");
    touch("compose/x.yml");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [{ id: 299, sha: skipped, jobs: [cell("success")], gate: gateSkip(realRun) }],
      }),
    });

    expectRun(result);
  });

  it("writes run when the skipping pipeline's own change was update-relevant", async () => {
    // The skip would have been wrong to rely on: the diff runs from the real run.
    const realRun = git("rev-parse", "HEAD");
    const skipped = touch("scripts/install.sh");
    touch("src/b.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [{ id: 299, sha: skipped, jobs: [cell("success")], gate: gateSkip(realRun) }],
      }),
    });

    expectRun(result);
  });
});

describe("which earlier pipeline is the base", () => {
  it("walks on past a failed cell to an older pipeline that passed", async () => {
    const older = git("rev-parse", "HEAD");
    const newer = touch("src/a.test.ts");
    touch("src/b.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [
          { id: 299, sha: newer, jobs: [cell("failed")], gate: gateRun },
          passedRun(older, 298),
        ],
      }),
    });

    expect(result).toEqual({ decision: "skip", since: older });
  });

  it("does not count a pipeline as passed when any one cell failed", async () => {
    const older = git("rev-parse", "HEAD");
    const newer = touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [
          {
            id: 299,
            sha: newer,
            jobs: [cell("success", "upgrade_cell", 1), cell("failed", "upgrade_cell", 2)],
            gate: gateRun,
          },
          passedRun(older, 298),
        ],
      }),
    });

    expect(result).toEqual({ decision: "skip", since: older });
  });

  it("counts the launcher job as one of the cells", async () => {
    const older = git("rev-parse", "HEAD");
    const newer = touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [
          {
            id: 299,
            sha: newer,
            jobs: [cell("success", "upgrade_cell", 1), cell("failed", "upgrade_cell_launcher", 2)],
            gate: gateRun,
          },
          passedRun(older, 298),
        ],
      }),
    });

    expect(result).toEqual({ decision: "skip", since: older });
  });

  it("takes the newest passed pipeline when several passed", async () => {
    const oldest = git("rev-parse", "HEAD");
    const newer = touch("scripts/install.sh");
    touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [passedRun(newer, 299), passedRun(oldest, 298)],
      }),
    });

    // The newest passed run is the base, so the installer change is covered.
    expect(result).toEqual({ decision: "skip", since: newer });
  });

  it("never uses the current pipeline as the base", async () => {
    const older = git("rev-parse", "HEAD");
    const current = touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({
        pipelines: [passedRun(current, CURRENT, gateSkip(older)), passedRun(older, 298)],
      }),
    });

    expect(result).toEqual({ decision: "skip", since: older });
  });

  it("asks only about this merge request's pipelines, up to twenty", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");
    const pipelines = Array.from({ length: 25 }, (unused, index) => ({
      id: 299 - index,
      sha: base,
      jobs: index === 22 ? [cell("success")] : [],
      gate: gateRun,
    }));

    const result = await gate({ fetchImpl: fakeFetch({ pipelines }) });

    // The only passed pipeline is the 23rd, beyond the cap: no base, so run.
    expectRun(result);
    const jobCalls = calls.filter((call) => /\/pipelines\/\d+\/jobs/u.test(call.url));
    expect(jobCalls.length).toBeLessThanOrEqual(20);
    expect(calls[0].url).toContain(`/projects/${PROJECT}/merge_requests/${MR}/pipelines`);
  });

  it("reads the gate file from the classify job of the passed pipeline", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");

    await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expect(calls.map((call) => new URL(call.url).pathname)).toContain(
      "/api/v4/projects/49/jobs/2990/artifacts/.orbit-upgrade/gate.env",
    );
  });
});

describe("the escape hatches and the pipelines that always run", () => {
  async function withASkippablePass(env) {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");
    const result = await gate({ env, fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });
    return result;
  }

  it("writes run, asking nothing, when there is no token", async () => {
    const result = await withASkippablePass({ ORBIT_REUSE_TOKEN: "" });

    expectRun(result);
    expect(calls).toEqual([]);
  });

  it("writes run, asking nothing, when the token variable is absent", async () => {
    const result = await withASkippablePass({ ORBIT_REUSE_TOKEN: undefined });

    expectRun(result);
    expect(calls).toEqual([]);
  });

  it("writes run, asking nothing, when the merge request is labelled 'ci: rerun'", async () => {
    const result = await withASkippablePass({ CI_MERGE_REQUEST_LABELS: "type: chore,ci: rerun" });

    expectRun(result);
    expect(calls).toEqual([]);
  });

  it("is not turned off by some other label", async () => {
    const result = await withASkippablePass({ CI_MERGE_REQUEST_LABELS: "ci: acceptance" });

    expect(result.decision).toBe("skip");
  });

  it("writes run, asking nothing, when ORBIT_REUSE is off", async () => {
    const result = await withASkippablePass({ ORBIT_REUSE: "off" });

    expectRun(result);
    expect(calls).toEqual([]);
  });

  it("writes run for a merge request into dev", async () => {
    const result = await withASkippablePass({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "dev" });

    expectRun(result);
  });

  it("writes run for a push to a hotfix branch", async () => {
    const result = await withASkippablePass({
      CI_PIPELINE_SOURCE: "push",
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: undefined,
      CI_MERGE_REQUEST_IID: undefined,
      CI_COMMIT_BRANCH: "hotfix/v0.3.6-1",
    });

    expectRun(result);
  });

  it("writes run for a push to preview", async () => {
    const result = await withASkippablePass({
      CI_PIPELINE_SOURCE: "push",
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: undefined,
      CI_MERGE_REQUEST_IID: undefined,
    });

    expectRun(result);
  });

  it("writes run for a scheduled pipeline", async () => {
    const result = await withASkippablePass({ CI_PIPELINE_SOURCE: "schedule" });

    expectRun(result);
  });
});

describe("any doubt writes run, and the script never throws", () => {
  it("writes run when the merge request's pipelines cannot be listed", async () => {
    touch("src/a.test.ts");

    const result = await gate({ fetchImpl: fakeFetch({ mrPipelinesStatus: 500 }) });

    expectRun(result);
    expectNoTokenAnywhere();
  });

  it("writes run when the request itself throws", async () => {
    touch("src/a.test.ts");
    const fetchImpl = async () => {
      throw new Error(`connection refused (token ${TOKEN} must not leak)`);
    };

    const result = await gate({ fetchImpl });

    expectRun(result);
    expect(lines()).not.toContain(TOKEN);
  });

  it("writes run when the jobs of a pipeline cannot be listed", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({ pipelines: [passedRun(base)], jobsStatus: 500 }),
    });

    expectRun(result);
  });

  it("writes run when the pipeline list is not JSON of the expected shape", async () => {
    touch("src/a.test.ts");
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
      text: async () => "<html>",
    });

    const result = await gate({ fetchImpl });

    expectRun(result);
  });

  it("writes run when the gate file is missing", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({ pipelines: [{ ...passedRun(base, 299), gate: undefined }] }),
    });

    expectRun(result);
  });

  it.each([
    ["garbage", "this is not a dotenv file\n\u0000\u0001"],
    ["empty", ""],
    ["an unknown verdict", "UPGRADE_CELLS=maybe\n"],
    ["a skip with no sha", "UPGRADE_CELLS=skip\n"],
    ["a skip with an empty sha", "UPGRADE_CELLS=skip\nUPGRADE_CELLS_SINCE=\n"],
    ["a skip with a malformed sha", "UPGRADE_CELLS=skip\nUPGRADE_CELLS_SINCE=not-a-sha\n"],
  ])("writes run when the gate file is malformed (%s)", async (unused, gateText) => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");

    const result = await gate({
      fetchImpl: fakeFetch({ pipelines: [passedRun(base, 299, gateText)] }),
    });

    expectRun(result);
  });

  it("writes run when the git diff fails because the base is unknown and cannot be fetched", async () => {
    touch("src/a.test.ts");
    const unknownBase = "1234567890abcdef1234567890abcdef12345678";

    const result = await gate({
      fetchImpl: fakeFetch({ pipelines: [passedRun(unknownBase)] }),
    });

    expectRun(result);
  });

  it("writes run when the working directory is not a git repository", async () => {
    const base = git("rev-parse", "HEAD");
    const notARepo = mkdtempSync(join(directory, "plain-"));

    const result = await run({
      env: environment(),
      argv: [outFile],
      fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }),
      cwd: notARepo,
      log,
    });

    expectRun(result);
  });
});

describe("the token", () => {
  it("is sent as the PRIVATE-TOKEN header on every request", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");

    await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const names = Object.keys(call.headers);
      const name = names.find((entry) => entry.toLowerCase() === "private-token");
      expect(name).toBeDefined();
      expect(call.headers[name]).toBe(TOKEN);
    }
    expect(calls.map((call) => call.url).join("\n")).not.toContain(TOKEN);
  });

  it("goes to the configured API base", async () => {
    await gate({ fetchImpl: fakeFetch({ pipelines: [] }) });

    expect(calls.every((call) => call.url.startsWith(`${API}/`))).toBe(true);
  });

  it("appears in no logged line, whatever was decided", async () => {
    const base = git("rev-parse", "HEAD");
    touch("src/a.test.ts");
    await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });
    expectNoTokenAnywhere();

    touch("scripts/install.sh");
    await gate({ fetchImpl: fakeFetch({ pipelines: [passedRun(base)] }) });
    expectNoTokenAnywhere();

    await gate({ fetchImpl: fakeFetch({ mrPipelinesStatus: 401 }) });
    expectNoTokenAnywhere();

    await gate({ env: { ORBIT_REUSE: "off" }, fetchImpl: fakeFetch() });
    expectNoTokenAnywhere();
  });
});
