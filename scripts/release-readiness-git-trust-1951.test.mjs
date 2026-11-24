import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import * as readiness from "./release-readiness.mjs";

/*
 * #1951: the CI pipeline trusts the checkout through GIT_CONFIG_COUNT and
 * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>. Child scripts must receive exactly
 * those (n below COUNT) so their git calls work; tokens stay out.
 */
const root = mkdtempSync(join(tmpdir(), "release-readiness-git-trust-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CONFIG_NAMES = ["GIT_CONFIG_COUNT", ...[0, 1, 2, 3].flatMap((n) => [`GIT_CONFIG_KEY_${n}`, `GIT_CONFIG_VALUE_${n}`])];
const OTHER_NAMES = ["GITLAB_TOKEN", "CI_JOB_TOKEN", "ORBIT_REUSE_TOKEN", "CI_COMMIT_SHA", "CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"];
const saved = {};
beforeEach(() => {
  for (const name of [...CONFIG_NAMES, ...OTHER_NAMES]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of [...CONFIG_NAMES, ...OTHER_NAMES]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function setPairs(count, pairs) {
  if (count !== undefined) process.env.GIT_CONFIG_COUNT = count;
  for (const [n, key, value] of pairs) {
    process.env[`GIT_CONFIG_KEY_${n}`] = key;
    process.env[`GIT_CONFIG_VALUE_${n}`] = value;
  }
}

const env = () => readiness.scriptEnv();
const configEntries = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith("GIT_CONFIG_")));

describe("scriptEnv git config passthrough (#1951)", () => {
  it("is exported", () => {
    expect(typeof readiness.scriptEnv).toBe("function");
  });

  it("COUNT=1 passes COUNT, KEY_0 and VALUE_0", () => {
    setPairs("1", [[0, "safe.directory", "/builds/x"]]);
    expect(configEntries(env())).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/builds/x" });
  });

  it("COUNT=2 passes both pairs", () => {
    setPairs("2", [[0, "safe.directory", "/builds/x"], [1, "core.abbrev", "9"]]);
    expect(configEntries(env())).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/builds/x",
      GIT_CONFIG_KEY_1: "core.abbrev",
      GIT_CONFIG_VALUE_1: "9",
    });
  });

  it("does not pass pairs at or beyond COUNT", () => {
    setPairs("1", [[0, "safe.directory", "/builds/x"], [1, "core.abbrev", "9"], [2, "a.b", "c"]]);
    const got = configEntries(env());
    expect(got).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/builds/x" });
  });

  it("passes none when COUNT is unset", () => {
    setPairs(undefined, [[0, "safe.directory", "/builds/x"]]);
    expect(configEntries(env())).toEqual({});
  });

  it.each(["abc", "-1", "1.5", "", " 1", "1e3", "99999999999", "1000000"])("passes none when COUNT is %j", (count) => {
    setPairs(count, [[0, "safe.directory", "/builds/x"]]);
    expect(configEntries(env())).toEqual({});
  });

  it("still never passes token variables", () => {
    setPairs("1", [[0, "safe.directory", "/builds/x"]]);
    process.env.GITLAB_TOKEN = "fake-token";
    process.env.CI_JOB_TOKEN = "fake-job-token";
    process.env.ORBIT_REUSE_TOKEN = "fake-reuse-token";
    const got = env();
    expect(got).not.toHaveProperty("GITLAB_TOKEN");
    expect(got).not.toHaveProperty("CI_JOB_TOKEN");
    expect(got).not.toHaveProperty("ORBIT_REUSE_TOKEN");
  });

  it("still never passes tokens when COUNT is absent", () => {
    process.env.GITLAB_TOKEN = "fake-token";
    process.env.CI_JOB_TOKEN = "fake-job-token";
    expect(Object.keys(env())).not.toContain("GITLAB_TOKEN");
    expect(Object.keys(env())).not.toContain("CI_JOB_TOKEN");
  });
});

describe("child script sees the git config from process.env (#1951)", () => {
  // The base-image child script succeeds only if git, run inside it, reads trust.probe=yes.
  function repoWithProbe() {
    const dir = mkdtempSync(join(root, "repo-"));
    const run = (args) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    run(["init", "-q", "-b", "dev"]);
    run(["remote", "add", "origin", join(root, "no-such-remote.git")]);
    mkdirSync(join(dir, "scripts"));
    const script = join(dir, "scripts", "check-base-image-current.sh");
    writeFileSync(script, '#!/usr/bin/env bash\n[ "$(git config --get trust.probe)" = "yes" ]\n');
    chmodSync(script, 0o755);
    return dir;
  }

  it("lets a GIT_CONFIG_KEY_0/VALUE_0 pair reach git in the child", async () => {
    const dir = repoWithProbe();
    process.env.CI_COMMIT_SHA = "0".repeat(40);
    setPairs("1", [[0, "trust.probe", "yes"]]);
    const lookups = readiness.realLookups({ repoDir: dir, target: "preview", remote: "origin" });
    expect(await lookups.baseImageCurrent()).toBe(true);
  });

  it("fails the probe when no pair is set (control)", async () => {
    const dir = repoWithProbe();
    process.env.CI_COMMIT_SHA = "0".repeat(40);
    const lookups = readiness.realLookups({ repoDir: dir, target: "preview", remote: "origin" });
    expect(await lookups.baseImageCurrent()).toBe(false);
  });
});
