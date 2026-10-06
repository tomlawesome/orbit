import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, "check-base-image-current.sh");

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "orbit-base-image-check-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * A `docker` that refuses, so the check stops at the registry lookup. Everything
 * this file cares about -- finding the first FROM and deciding whether it is
 * pinned -- happens before that, and stubbing it keeps the test off the network
 * and independent of whether the host has a daemon at all.
 */
function stubDockerOnPath() {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "docker");
  writeFileSync(stub, "#!/bin/sh\nexit 1\n");
  chmodSync(stub, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

/**
 * A `docker` that answers `manifest inspect` with a single linux/amd64 entry
 * pinned to `newDigest`, so the script reaches the "tag has moved" branch --
 * the one #1027 is about -- instead of stopping at the registry lookup.
 * Anything else (the `docker run` axis-2 probe) still refuses, but the moved-
 * tag branch always exits before reaching it.
 */
function stubDockerReturningDigest(newDigest) {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "docker");
  const manifestJson = JSON.stringify({
    manifests: [{ platform: { os: "linux", architecture: "amd64" }, digest: newDigest }],
  });
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then',
      `  cat <<'MANIFEST_EOF'`,
      manifestJson,
      "MANIFEST_EOF",
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

function digest(seed) {
  return `sha256:${String(seed).padStart(64, "0")}`;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * A git repository at `dir` whose checked-out Dockerfile pins `branchRef`,
 * with a `dev` branch that pins `devRef` reachable the way the fix's two
 * paths need it: either already present as `origin/dev` (no fetch needed) or
 * only present on a separate "upstream" repo added as the `origin` remote
 * but not yet fetched (the shallow-clone case the fetch fallback covers).
 * `devRef: null` reproduces "dev cannot be resolved at all" -- no remote, no
 * local ref -- which must fall back to today's message rather than crash.
 */
function initRepoWithDevPin(dir, { branchRef, devRef, fetched }) {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "--quiet", "--initial-branch=work"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "Dockerfile"), `FROM ${branchRef} AS base\n`);
  runGit(dir, ["add", "Dockerfile"]);
  runGit(dir, ["commit", "--quiet", "-m", "work"]);

  if (devRef === null) {
    return; // No remote at all: dev is simply unreachable.
  }

  if (fetched) {
    // Simulates a ref already available locally (e.g. a full-history job
    // that fetched dev itself) -- a branch literally named "origin/dev"
    // resolves the same way refs/remotes/origin/dev would.
    runGit(dir, ["checkout", "--quiet", "-b", "origin/dev"]);
    writeFileSync(join(dir, "Dockerfile"), `FROM ${devRef} AS base\n`);
    runGit(dir, ["add", "Dockerfile"]);
    runGit(dir, ["commit", "--quiet", "--allow-empty", "-m", "dev"]);
    runGit(dir, ["checkout", "--quiet", "work"]);
    return;
  }

  // Simulates the ordinary CI clone: dev lives only on a separate upstream
  // repository added as the `origin` remote, never fetched into this
  // checkout. The script's fallback `git fetch` must reach it.
  const upstream = `${dir}-upstream`;
  mkdirSync(upstream, { recursive: true });
  runGit(upstream, ["init", "--quiet", "--initial-branch=dev"]);
  runGit(upstream, ["config", "user.email", "test@example.invalid"]);
  runGit(upstream, ["config", "user.name", "Test"]);
  writeFileSync(join(upstream, "Dockerfile"), `FROM ${devRef} AS base\n`);
  runGit(upstream, ["add", "Dockerfile"]);
  runGit(upstream, ["commit", "--quiet", "--allow-empty", "-m", "dev"]);
  runGit(dir, ["remote", "add", "origin", upstream]);
}

/**
 * A multi-stage Dockerfile that opens with a comment block, like Orbit's own.
 *
 * `stages` is deliberately far larger than any real Dockerfile. The bug this
 * file exists to catch was a race -- `sed ... | head -1` under `pipefail`, where
 * sed kept writing after head exited, took SIGPIPE, and aborted the whole script
 * with 141 before it printed anything. On Orbit's seven-stage Dockerfile the
 * race is lost only sometimes: never on a GitHub runner, about three times in
 * four on the busybox `base_image` job (GitLab pipeline 169). A producer with
 * thousands of lines still to write loses it every time on every platform, so
 * the regression fails here rather than intermittently in CI.
 */
function writeDockerfile({ firstReference, stages = 3000 }) {
  const lines = [
    "# A comment block above the first FROM, which #651 proved is legal and",
    "# which this check must read past rather than assume line 1.",
    "",
    `FROM ${firstReference} AS base`,
  ];
  for (let stage = 1; stage <= stages; stage += 1) {
    lines.push(`FROM example.invalid/orbit-stage@${digest(stage)} AS stage${stage}`);
  }
  const path = join(workdir, "Dockerfile");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function runCheck(dockerfile, env = stubDockerOnPath()) {
  return spawnSync("bash", [script, dockerfile], {
    encoding: "utf8",
    env,
  });
}

describe("scripts/check-base-image-current.sh", () => {
  it("reads the first FROM of a long multi-stage Dockerfile without a SIGPIPE race", () => {
    const pinned = `ghcr.io/tomlawesome/orbit-base-image:latest@${digest(1)}`;
    const dockerfile = writeDockerfile({ firstReference: pinned });

    // Repeated because the failure it guards against was intermittent by
    // nature: one green run never proved the pipeline could not lose the race.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = runCheck(dockerfile);

      expect(result.status, `attempt ${attempt}: 141 is SIGPIPE, not a verdict`).not.toBe(141);
      expect(result.stdout).toContain(`base image: pinned ${pinned}`);
      // It got past the FROM and failed at the stubbed registry lookup, which
      // is the next thing it does and the only thing left to fail on.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("could not resolve");
    }
  });

  it("refuses an unpinned first FROM rather than reporting a base it cannot verify", () => {
    const dockerfile = writeDockerfile({ firstReference: "alpine:3.22" });

    const result = runCheck(dockerfile);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a digest-pinned reference");
    expect(result.stderr).toContain("an unpinned base must not ship");
  });

  it("refuses a Dockerfile with no FROM at all", () => {
    const path = join(workdir, "Dockerfile");
    writeFileSync(path, "# nothing but comments\n");

    const result = runCheck(path);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("<none>");
  });
});

// #1027: a branch merely behind `dev` looked identical to a moved tag, and
// the advice to hand-edit the FROM line was wrong in that case -- it went
// green while leaving the branch behind, and would have written a second,
// conflicting re-pin commit against the one already on `dev`.
describe("scripts/check-base-image-current.sh -- moved tag vs. behind dev (#1027)", () => {
  const pinnedTag = "ghcr.io/tomlawesome/orbit-base-image:latest";

  it("tells the reader to merge dev when dev already pins the tag's current digest", () => {
    const staleDigest = digest(201);
    const currentDigest = digest(202);
    const repoDir = join(workdir, "repo");
    initRepoWithDevPin(repoDir, {
      branchRef: `${pinnedTag}@${staleDigest}`,
      devRef: `${pinnedTag}@${currentDigest}`,
      fetched: true,
    });

    const result = runCheck(join(repoDir, "Dockerfile"), stubDockerReturningDigest(currentDigest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dev' already pins the current digest");
    expect(result.stderr).toContain("Merge");
    expect(result.stderr).not.toContain("Update the first FROM");
  });

  it("falls back to fetching dev when it is not already present locally", () => {
    // The ordinary CI shape: dev lives only on the `origin` remote, not yet
    // fetched into this checkout, which is what a shallow clone leaves it.
    const staleDigest = digest(203);
    const currentDigest = digest(204);
    const repoDir = join(workdir, "repo-unfetched");
    initRepoWithDevPin(repoDir, {
      branchRef: `${pinnedTag}@${staleDigest}`,
      devRef: `${pinnedTag}@${currentDigest}`,
      fetched: false,
    });

    const result = runCheck(join(repoDir, "Dockerfile"), stubDockerReturningDigest(currentDigest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dev' already pins the current digest");
    expect(result.stderr).not.toContain("Update the first FROM");
  });

  it("keeps the re-pin advice when dev has not re-pinned either", () => {
    const staleDigest = digest(205);
    const currentDigest = digest(206);
    const repoDir = join(workdir, "repo-dev-stale");
    initRepoWithDevPin(repoDir, {
      branchRef: `${pinnedTag}@${staleDigest}`,
      devRef: `${pinnedTag}@${staleDigest}`, // dev is behind too: the re-pin is genuinely owed.
      fetched: true,
    });

    const result = runCheck(join(repoDir, "Dockerfile"), stubDockerReturningDigest(currentDigest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the tag has moved.");
    expect(result.stderr).toContain("Update the first FROM");
  });

  it("falls back to the tag-moved advice when dev has no remote to resolve it from", () => {
    const staleDigest = digest(207);
    const currentDigest = digest(208);
    const repoDir = join(workdir, "repo-no-dev");
    initRepoWithDevPin(repoDir, {
      branchRef: `${pinnedTag}@${staleDigest}`,
      devRef: null,
      fetched: false,
    });

    const result = runCheck(join(repoDir, "Dockerfile"), stubDockerReturningDigest(currentDigest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the tag has moved.");
    expect(result.stderr).toContain("Update the first FROM");
  });

  it("falls back to the tag-moved advice when the Dockerfile is not inside a git repository", () => {
    const staleDigest = digest(209);
    const currentDigest = digest(210);
    const dockerfile = writeDockerfile({ firstReference: `${pinnedTag}@${staleDigest}`, stages: 0 });

    const result = runCheck(dockerfile, stubDockerReturningDigest(currentDigest));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the tag has moved.");
    expect(result.stderr).toContain("Update the first FROM");
  });
});
