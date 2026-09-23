/**
 * The commit-and-push half of scripts/ci/repin-base-image.sh, exercised
 * without a real token or registry (#1020's Debt).
 *
 * #1020 itself was `set -Eeuo pipefail` tripping on
 * `$($packages_stale && printf ...)` while building the commit message: when
 * packages were NOT stale (the common case) that substitution's own exit
 * status was 1, so the assignment failed and the script died silently, right
 * after logging "nothing stale; the build may proceed" and before `git
 * commit` ever ran. `--red` only self-tests the digest comparison; nothing
 * exercised the commit-and-push half at all, so the fix (an `if`, not `&&`,
 * landed in !928) shipped with no regression test.
 *
 * This drives the real script end to end, past corroboration, the
 * commit-message build, `git commit`, and `git push`, against a scratch git
 * repository and a local bare repository standing in for the GitLab remote.
 * Three testing seams make that possible without a token, docker or a
 * network: BASE_IMAGE_DIGEST_FILE and BASE_IMAGE_PACKAGES_SIMULATION already
 * existed; BASE_IMAGE_MANIFEST_SIMULATION, BASE_REPIN_PUSH_URL and
 * BASE_REPIN_STOP_AFTER_PUSH were added alongside this file. None of the five
 * are set by .gitlab-ci.yml, so production behaviour is unchanged.
 *
 * Both values of packages_stale are run, because #1020 only bit on one of
 * them -- a suite that only tried the stale case would have stayed green
 * throughout.
 *
 * Uses node:test, not vitest globals, like the other script-driving suites
 * (scripts/compose-project-name-resolution.test.mjs, #921). Run standalone:
 * `node --test scripts/ci/repin-base-image.test.mjs`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { failOnProcessDeadline, processGuard } from "../process-budget.mjs";

const scriptSource = readFileSync(join(import.meta.dirname, "repin-base-image.sh"), "utf8");

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
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

const IMAGE_TAG = "ghcr.io/tomlawesome/orbit-repin-test:latest";
const IMAGE_NAME = "ghcr.io/tomlawesome/orbit-repin-test";
const OLD_PLATFORM_DIGEST = digest(1); // Currently pinned in the Dockerfile.
const OLD_INDEX_DIGEST = digest(2); // Currently pinned in the policy file.
const NEW_INDEX_DIGEST = digest(3); // The artifact's trusted digest: differs from OLD_INDEX_DIGEST so axis 1 reports "moved".
const NEW_PLATFORM_DIGEST = digest(4); // What the live tag's index resolves linux/amd64 to; what actually gets pinned.

/**
 * A scratch git repository laid out the way repin-base-image.sh's own
 * `repo_dir` resolution needs: the script computes its repo root from its own
 * `BASH_SOURCE`, two directories up, so the script must live at
 * `<repo>/scripts/ci/repin-base-image.sh` for the git operations inside it
 * (checkout, add, commit, push) to land in the scratch repo rather than this
 * checkout.
 */
function deployRepinRepo() {
  const repoDir = scratchDir("orbit-repin-repo-");
  mkdirSync(join(repoDir, "scripts", "ci"), { recursive: true });
  mkdirSync(join(repoDir, ".github"), { recursive: true });
  writeFileSync(join(repoDir, "scripts", "ci", "repin-base-image.sh"), scriptSource);
  writeFileSync(join(repoDir, "Dockerfile"), `FROM ${IMAGE_TAG}@${OLD_PLATFORM_DIGEST} AS base\n`);
  writeFileSync(
    join(repoDir, ".github", "supply-chain-policy.json"),
    `${JSON.stringify(
      {
        containerImages: [
          {
            tag: IMAGE_TAG,
            reference: `${IMAGE_TAG}@${OLD_PLATFORM_DIGEST}`,
            indexDigest: OLD_INDEX_DIGEST,
            resolvedOn: "2026-01-01",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  runGit(repoDir, ["init", "--quiet", "--initial-branch=work"]);
  runGit(repoDir, ["config", "user.email", "test@example.invalid"]);
  runGit(repoDir, ["config", "user.name", "Test"]);
  runGit(repoDir, ["add", "-A"]);
  runGit(repoDir, ["commit", "--quiet", "-m", "initial"]);

  return repoDir;
}

function deployBareRemote() {
  const bareDir = scratchDir("orbit-repin-bare-");
  runGit(bareDir, ["init", "--quiet", "--bare"]);
  return bareDir;
}

function deployStubCheckScript() {
  const dir = scratchDir("orbit-repin-check-stub-");
  const path = join(dir, "check-stub.sh");
  writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
  return path;
}

const MANIFEST_SIMULATION = JSON.stringify({
  mediaType: "application/vnd.oci.image.index.v1+json",
  digest: NEW_INDEX_DIGEST,
  manifests: [{ platform: { os: "linux", architecture: "amd64" }, digest: NEW_PLATFORM_DIGEST }],
});

const PACKAGES_SIMULATION_CURRENT = "OK: nothing to upgrade\n";
const PACKAGES_SIMULATION_STALE = "(1/2) Upgrading musl (1.2.3-r0 -> 1.2.4-r0)\n(2/2) Upgrading busybox (1.36.0-r0 -> 1.36.1-r0)\n";

/**
 * Runs the real script (a copy, from `repoDir`) against a local bare
 * repository standing in for the GitLab remote, with a fake token and no
 * network reachable at all: BASE_IMAGE_DIGEST_FILE stands in for the
 * CI_JOB_TOKEN artifact fetch, BASE_IMAGE_MANIFEST_SIMULATION for `docker
 * buildx imagetools inspect`, BASE_IMAGE_PACKAGES_SIMULATION for the `docker
 * run` packages probe, and CHECK_SCRIPT for the freshness-gate verification
 * -- none of which this test needs to re-prove, all of which have their own
 * coverage elsewhere.
 */
function runRepin({ repoDir, bareDir, packagesStale }) {
  const digestFile = join(repoDir, "trusted-digest.txt");
  writeFileSync(digestFile, `${IMAGE_NAME}@${NEW_INDEX_DIGEST}`);

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? tmpdir(),
    CHECK_SCRIPT: deployStubCheckScript(),
    BASE_IMAGE_DIGEST_FILE: digestFile,
    BASE_IMAGE_MANIFEST_SIMULATION: MANIFEST_SIMULATION,
    BASE_IMAGE_PACKAGES_SIMULATION: packagesStale ? PACKAGES_SIMULATION_STALE : PACKAGES_SIMULATION_CURRENT,
    BASE_REPIN_TOKEN: "fake-test-token",
    BASE_REPIN_PUSH_URL: bareDir,
    BASE_REPIN_STOP_AFTER_PUSH: "1",
    CI_PROJECT_ID: "49",
    CI_PROJECT_PATH: "ai/orbit",
    CI_SERVER_HOST: "gitlab.example.invalid",
  };

  return failOnProcessDeadline(
    spawnSync("bash", [join(repoDir, "scripts", "ci", "repin-base-image.sh")], {
      cwd: repoDir,
      encoding: "utf8",
      env,
      ...processGuard(),
    }),
    { label: "repin-base-image.sh" },
  );
}

function pushedCommitMessage(bareDir, branch = "chore/base-image-repin") {
  return runGit(bareDir, ["log", "-1", `--format=%B`, branch]);
}

function pushedDockerfile(bareDir, branch = "chore/base-image-repin") {
  return runGit(bareDir, ["show", `${branch}:Dockerfile`]);
}

for (const packagesStale of [true, false]) {
  describe(`repin-base-image.sh commits and pushes to a local bare repo (packages_stale=${packagesStale})`, () => {
    it("commits the re-pin and pushes it, exiting 0", () => {
      const repoDir = deployRepinRepo();
      const bareDir = deployBareRemote();

      const result = runRepin({ repoDir, bareDir, packagesStale });

      assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      assert.match(result.stdout, /BASE_REPIN_STOP_AFTER_PUSH set: stopping after the push/u);

      const dockerfile = pushedDockerfile(bareDir);
      assert.equal(dockerfile, `FROM ${IMAGE_TAG}@${NEW_PLATFORM_DIGEST} AS base\n`);

      const message = pushedCommitMessage(bareDir);
      assert.match(message, new RegExp(`Re-pin the Orbit base image to ${NEW_PLATFORM_DIGEST}`, "u"));
      if (packagesStale) {
        assert.match(message, /Packages inside the new image were still reported behind at build time; see #706\./u);
      } else {
        assert.doesNotMatch(message, /Packages inside the new image were still reported behind/u);
      }
    });
  });
}

describe("repin-base-image.sh clears the runner's inherited auth header before pushing (#1081)", () => {
  it("removes every http.*.extraheader from the checkout, naming each without printing its value", () => {
    const repoDir = deployRepinRepo();
    const bareDir = deployBareRemote();

    // What GitLab Runner leaves in /builds/<project>/.git/config. The value
    // shape is the runner's: a base64 basic-auth blob carrying CI_JOB_TOKEN.
    const key = "http.https://gitlab.example.invalid.extraheader";
    const secret = "AUTHORIZATION: Basic Z2l0bGFiLWNpLXRva2VuOmpvYi10b2tlbi12YWx1ZQ==";
    runGit(repoDir, ["config", "--add", key, secret]);

    const result = runRepin({ repoDir, bareDir, packagesStale: false });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    // The header is gone, so nothing but the credential helper can
    // authenticate the push. This is the assertion that fails without the fix.
    const remaining = spawnSync("git", ["config", "--name-only", "--get-regexp", "^http\\..*\\.extraheader$"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    assert.equal(remaining.stdout.trim(), "", `an inherited auth header survived: ${remaining.stdout}`);

    // Named in the log, so a future 403 can be told apart from this one.
    assert.match(result.stdout, /clearing an inherited git auth header before the push: http\./u);

    // Never the value: it is a working job token.
    assert.doesNotMatch(result.stdout + result.stderr, /Z2l0bGFiLWNpLXRva2Vu/u);
  });
});

// Proves this suite would have caught #1020: with the original
// `$($packages_stale && printf ...)` form restored, the packages_stale=false
// run must fail under `set -e` exactly the way the bug report describes --
// silently, right after axis 2's log line, before `git commit`. See the
// commit message for the before/after run this test was written against.
