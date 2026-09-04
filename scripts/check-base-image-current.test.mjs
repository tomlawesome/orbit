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

function digest(seed) {
  return `sha256:${String(seed).padStart(64, "0")}`;
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

function runCheck(dockerfile) {
  return spawnSync("bash", [script, dockerfile], {
    encoding: "utf8",
    env: stubDockerOnPath(),
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
