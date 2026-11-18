import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { realLookups } from "./release-readiness.mjs";

/*
 * The real lookups behind scripts/release-readiness.mjs (#1860), run against
 * temporary git repositories made here, with the GitLab API stubbed through
 * fetch. No network, no real remote: a remote-tracking ref is made by hand.
 */
const root = mkdtempSync(join(tmpdir(), "release-readiness-lookups-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GUIDE = [
  "# Releasing",
  "",
  "## What you do, in short",
  "",
  "To ship a stable release:",
  "",
  "1. Open the promotion into preview.",
  "2. Accept the release on the preview.",
  "   More words about step two.",
  "3. Update the roadmap.",
  "",
  "## The rest",
  "",
  "1. Not a step of the short list.",
  "",
].join("\n");

const VERSION = "v0.3.9";

function recordText({ blob, version = VERSION, signoff = "Ada Agent", steps } = {}) {
  const lines = steps ?? ["step 1: after-merge", "step 2: done: https://example.test/job/1", "step 3: not-needed: owner decision 2026-11-16"];
  return [
    `version: ${version}`,
    `guide-blob: ${blob}`,
    "guide-commit: 0000000000000000000000000000000000000000",
    "",
    ...lines,
    "",
    ...(signoff === null ? [] : [`Signed-off-by: ${signoff}`]),
    "",
  ].join("\n");
}

function git(dir, args, env = {}) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let counter = 0;
function newRepo() {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "dev"]);
  git(dir, ["config", "user.name", "Ada Agent"]);
  git(dir, ["config", "user.email", "ada@example.test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["remote", "add", "origin", join(root, "no-such-remote.git")]);
  return dir;
}

function write(dir, path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function commit(dir, message, { trailer, author } = {}) {
  git(dir, ["add", "-A"]);
  const args = ["commit", "-q", "-m", message];
  if (trailer) args.push("--trailer", `Signed-off-by: ${trailer}`);
  const env = author ? { GIT_AUTHOR_NAME: author, GIT_COMMITTER_NAME: author } : {};
  git(dir, args, env);
  return git(dir, ["rev-parse", "HEAD"]);
}

const blobOf = (dir) => git(dir, ["rev-parse", "HEAD:docs/releasing.md"]);

// A repo holding the guide and a record for VERSION, committed as `options` say.
function repoWithRecord({ record = {}, commitOptions = { trailer: "Ada Agent" } } = {}) {
  const dir = newRepo();
  write(dir, "docs/releasing.md", GUIDE);
  commit(dir, "guide");
  write(dir, `docs/releases/${VERSION}.md`, recordText({ blob: blobOf(dir), ...record }));
  commit(dir, "record", commitOptions);
  return dir;
}

const lookupsFor = (dir, target = "preview") => realLookups({ repoDir: dir, target, remote: "origin" });

const savedEnv = {};
const ENV_NAMES = ["CI_MERGE_REQUEST_SOURCE_BRANCH_SHA", "CI_COMMIT_SHA", "CI_API_V4_URL", "CI_PROJECT_ID", "CI_JOB_TOKEN", "ORBIT_REUSE_TOKEN", "GITLAB_TOKEN"];
beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  vi.unstubAllGlobals();
});

describe("guideSteps", () => {
  it("lists the numbered steps under 'What you do, in short' only", async () => {
    const dir = repoWithRecord();
    expect((await lookupsFor(dir).guideSteps()).map(String)).toEqual(["1", "2", "3"]);
  });
  it("rejects when the guide has no such section", async () => {
    const dir = newRepo();
    write(dir, "docs/releasing.md", "# Releasing\n\nNothing here.\n");
    commit(dir, "guide");
    await expect(lookupsFor(dir).guideSteps()).rejects.toThrow();
  });
});

describe("guideCommit and the record's guide pin", () => {
  it("matches the blob the record names", async () => {
    const dir = repoWithRecord();
    const lookups = lookupsFor(dir);
    const record = await lookups.releaseRecord(VERSION);
    expect(record.guideCommit).toBe(await lookups.guideCommit());
    expect(record.guideCommit).toBe(blobOf(dir));
  });
  it("no longer matches after the guide is edited", async () => {
    const dir = repoWithRecord();
    write(dir, "docs/releasing.md", `${GUIDE}\nAn extra sentence.\n`);
    commit(dir, "edit guide");
    const lookups = lookupsFor(dir);
    const record = await lookups.releaseRecord(VERSION);
    expect(record.guideCommit).not.toBe(await lookups.guideCommit());
  });
  it("still matches after a commit that does not change the guide", async () => {
    const dir = repoWithRecord();
    write(dir, "other.txt", "x\n");
    commit(dir, "unrelated");
    const lookups = lookupsFor(dir);
    expect((await lookups.releaseRecord(VERSION)).guideCommit).toBe(await lookups.guideCommit());
  });
});

describe("releaseRecord", () => {
  it("parses a committed, signed record", async () => {
    const dir = repoWithRecord();
    const record = await lookupsFor(dir).releaseRecord(VERSION);
    expect(record.exists).toBe(true);
    expect(record.signed).toBe(true);
    expect(record.steps.map(String)).toEqual(["1", "2", "3"]);
  });
  it("says the record does not exist when none is committed for the version", async () => {
    const dir = repoWithRecord();
    const record = await lookupsFor(dir).releaseRecord("v0.4.0");
    expect(record.exists).toBe(false);
    expect(record.signed).toBe(false);
  });
  it("leaves out a step whose evidence is empty or a placeholder", async () => {
    const dir = repoWithRecord({
      record: { steps: ["step 1: after-merge", "step 2: done: <link or job id>", "step 3: done:"] },
    });
    const record = await lookupsFor(dir).releaseRecord(VERSION);
    expect(record.steps.map(String)).toEqual(["1"]);
  });
  it("leaves out a step with an unknown status", async () => {
    const dir = repoWithRecord({ record: { steps: ["step 1: after-merge", "step 2: maybe", "step 3: after-merge"] } });
    expect((await lookupsFor(dir).releaseRecord(VERSION)).steps.map(String)).toEqual(["1", "3"]);
  });

  describe("sign-off", () => {
    it("is signed when the line equals the author name and a Signed-off-by trailer", async () => {
      const dir = repoWithRecord({ commitOptions: { trailer: "Ada Agent" } });
      expect((await lookupsFor(dir).releaseRecord(VERSION)).signed).toBe(true);
    });
    it("is not signed when the commit has no Signed-off-by trailer", async () => {
      const dir = repoWithRecord({ commitOptions: {} });
      expect((await lookupsFor(dir).releaseRecord(VERSION)).signed).toBe(false);
    });
    it("is not signed when the line's name differs from the author name", async () => {
      const dir = repoWithRecord({ record: { signoff: "Someone Else" }, commitOptions: { trailer: "Someone Else" } });
      expect((await lookupsFor(dir).releaseRecord(VERSION)).signed).toBe(false);
    });
    it("is not signed when the trailer's name differs from the line", async () => {
      const dir = repoWithRecord({ commitOptions: { trailer: "Someone Else" } });
      expect((await lookupsFor(dir).releaseRecord(VERSION)).signed).toBe(false);
    });
    it("is not signed when the line holds an email, and says why", async () => {
      const dir = repoWithRecord({
        record: { signoff: "Ada Agent <ada@example.test>" },
        commitOptions: { trailer: "Ada Agent <ada@example.test>" },
      });
      const record = await lookupsFor(dir).releaseRecord(VERSION);
      expect(record.signed).toBe(false);
      expect(JSON.stringify(record.problems ?? [])).toMatch(/email/iu);
    });
    it("is not signed when the record has no Signed-off-by line", async () => {
      const dir = repoWithRecord({ record: { signoff: null } });
      expect((await lookupsFor(dir).releaseRecord(VERSION)).signed).toBe(false);
    });
    it("reads the last commit that touched the record", async () => {
      const dir = repoWithRecord();
      write(dir, `docs/releases/${VERSION}.md`, `${recordText({ blob: blobOf(dir) })}\n`);
      commit(dir, "edit record without a trailer");
      expect((await lookupsFor(dir).releaseRecord(VERSION)).signed).toBe(false);
    });
  });
});

describe("containsTarget", () => {
  function repoWithTarget() {
    const dir = newRepo();
    write(dir, "a.txt", "a\n");
    const base = commit(dir, "base");
    git(dir, ["update-ref", "refs/remotes/origin/preview", base]);
    return { dir, base };
  }
  it("is true when the source contains the target", async () => {
    const { dir } = repoWithTarget();
    write(dir, "b.txt", "b\n");
    commit(dir, "work on dev");
    expect(await lookupsFor(dir).containsTarget()).toBe(true);
  });
  it("is true when the source is the target tip", async () => {
    const { dir } = repoWithTarget();
    expect(await lookupsFor(dir).containsTarget()).toBe(true);
  });
  it("is false when the target has commits the source lacks", async () => {
    const { dir, base } = repoWithTarget();
    git(dir, ["checkout", "-q", "-b", "other", base]);
    write(dir, "c.txt", "c\n");
    const ahead = commit(dir, "preview moved on");
    git(dir, ["update-ref", "refs/remotes/origin/preview", ahead]);
    git(dir, ["checkout", "-q", "dev"]);
    write(dir, "b.txt", "b\n");
    commit(dir, "work on dev");
    expect(await lookupsFor(dir).containsTarget()).toBe(false);
  });
  it("rejects when the target ref was never fetched", async () => {
    const dir = newRepo();
    write(dir, "a.txt", "a\n");
    commit(dir, "base");
    await expect(lookupsFor(dir).containsTarget()).rejects.toThrow();
  });
});

describe("slowGates (GitLab API stubbed)", () => {
  const GREEN = ["screens_chromium", "smoke", "fast"].map((job) => ({ name: job, status: "success" }));

  // pipelines: [{ id, sha, ref, sameTree, jobs }]; mergeRequests: { iid: targetBranch }
  function stubGitlab({ pipelines, mrPipelines = [], mergeRequests = {}, status = 200 }) {
    const requested = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^.*\/projects\/1/u, "");
        requested.push(`${path}${url.search}`);
        const reply = (body) => ({ ok: status === 200, status, json: async () => body });
        const strip = (list) => list.map(({ id, sha, ref }) => ({ id, sha, ref, web_url: `https://gitlab.example.test/p/${id}` }));
        if (path === "/pipelines" && url.searchParams.get("ref") === "dev") return reply(strip(pipelines));
        if (path === "/pipelines" && url.searchParams.get("source") === "merge_request_event") return reply(strip(mrPipelines));
        const mr = /^\/merge_requests\/(\d+)$/u.exec(path);
        if (mr) return reply({ target_branch: mergeRequests[mr[1]] });
        if (path === "/repository/compare") {
          const from = url.searchParams.get("from");
          const found = [...pipelines, ...mrPipelines].find((p) => p.sha === from);
          return reply({ diffs: found?.sameTree ? [] : [{ new_path: "x" }] });
        }
        const jobs = /^\/pipelines\/(\d+)\/jobs$/u.exec(path);
        if (jobs) {
          const found = [...pipelines, ...mrPipelines].find((p) => String(p.id) === jobs[1]);
          return reply(url.searchParams.get("page") === "1" ? (found?.jobs ?? []) : []);
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    return requested;
  }

  function repoForGates() {
    process.env.CI_API_V4_URL = "https://gitlab.example.test/api/v4";
    process.env.CI_PROJECT_ID = "1";
    process.env.GITLAB_TOKEN = "fake-placeholder-value";
    const dir = newRepo();
    write(dir, "a.txt", "a\n");
    commit(dir, "base");
    return dir;
  }

  it("returns the jobs of the newest dev pipeline whose commit has the same tree", async () => {
    const dir = repoForGates();
    stubGitlab({
      pipelines: [
        { id: 30, sha: "c3", ref: "dev", sameTree: false, jobs: GREEN.map((j) => ({ ...j, status: "failed" })) },
        { id: 20, sha: "c2", ref: "dev", sameTree: true, jobs: GREEN },
        { id: 10, sha: "c1", ref: "dev", sameTree: true, jobs: GREEN.map((j) => ({ ...j, status: "failed" })) },
      ],
    });
    const gates = await lookupsFor(dir).slowGates();
    expect(gates).toEqual(GREEN.map(({ name, status }) => ({ job: name, status })));
  });
  it("returns null when no dev pipeline has the same tree", async () => {
    const dir = repoForGates();
    stubGitlab({ pipelines: [{ id: 30, sha: "c3", ref: "dev", sameTree: false, jobs: GREEN }] });
    expect(await lookupsFor(dir).slowGates()).toBeNull();
  });
  it("looks further back when the same-tree pipeline never ran the slow gates", async () => {
    const dir = repoForGates();
    stubGitlab({
      pipelines: [
        { id: 30, sha: "c3", ref: "dev", sameTree: true, jobs: [{ name: "lint", status: "success" }] },
        { id: 20, sha: "c2", ref: "dev", sameTree: true, jobs: GREEN },
      ],
    });
    const gates = await lookupsFor(dir).slowGates();
    expect(gates.map((g) => g.job)).toEqual(GREEN.map((j) => j.name));
  });
  it("reports a failed job as failed", async () => {
    const dir = repoForGates();
    stubGitlab({
      pipelines: [
        { id: 20, sha: "c2", ref: "dev", sameTree: true, jobs: [{ name: "screens_chromium", status: "failed" }, { name: "smoke", status: "success" }, { name: "fast", status: "success" }] },
      ],
    });
    const gates = await lookupsFor(dir).slowGates();
    expect(gates.find((g) => g.job === "screens_chromium").status).toBe("failed");
  });
  it("skips a merge request pipeline whose target is not dev", async () => {
    const dir = repoForGates();
    stubGitlab({
      pipelines: [],
      mrPipelines: [{ id: 40, sha: "c4", ref: "refs/merge-requests/7/head", sameTree: true, jobs: GREEN }],
      mergeRequests: { 7: "preview" },
    });
    expect(await lookupsFor(dir).slowGates()).toBeNull();
  });
  it("reads a merge request pipeline whose target is dev", async () => {
    const dir = repoForGates();
    stubGitlab({
      pipelines: [],
      mrPipelines: [{ id: 40, sha: "c4", ref: "refs/merge-requests/7/head", sameTree: true, jobs: GREEN }],
      mergeRequests: { 7: "dev" },
    });
    expect(await lookupsFor(dir).slowGates()).not.toBeNull();
  });
  it("rejects when the API refuses, without putting the credential in the error", async () => {
    const dir = repoForGates();
    stubGitlab({ pipelines: [], status: 401 });
    const error = await lookupsFor(dir).slowGates().then(() => null, (e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("fake-placeholder-value");
  });
  it("rejects when there is no credential to read pipelines with", async () => {
    const dir = repoForGates();
    delete process.env.GITLAB_TOKEN;
    stubGitlab({ pipelines: [] });
    await expect(lookupsFor(dir).slowGates()).rejects.toThrow();
  });
});
