import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #1830 (condition 2, decision 9a): Orbit warns, and never fails, when the
// signing image it pins is more than 14 days old. Modelled on
// check-base-image-current.test.mjs: a stub `docker` on PATH answers the
// registry lookup, and fake digests and dates keep it off the network.
//
// Contract for scripts/check-signing-image-age.sh [ci-file]:
//   - reads ORBIT_SIGNING_IMAGE from the CI file (default .gitlab-ci.yml);
//   - asks `docker buildx imagetools inspect <ref> --format '{{json .Image}}'`
//     for the image config and reads its `created` timestamp;
//   - SIGNING_IMAGE_NOW (ISO 8601) overrides the clock; SIGNING_IMAGE_MAX_AGE_DAYS
//     overrides the 14-day limit;
//   - exit 0 when fresh (under the limit); exit 3 -- the code the job's
//     `allow_failure: exit_codes: 3` tolerates -- for a warning, whether the
//     image is stale (age >= limit) or its age cannot be read. Never any other
//     non-zero code for those two cases.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, "check-signing-image-age.sh");
const repoDir = join(scriptsDir, "..");
const WARNING_EXIT = 3;
const NOW = "2026-11-14T12:00:00Z";

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "orbit-signing-age-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const digest = (seed) => `sha256:${String(seed).padStart(64, "0")}`;

function writeCiFile(pinned) {
  const path = join(workdir, "ci.yml");
  writeFileSync(
    path,
    ["variables:", `  ORBIT_SIGNING_IMAGE: ${pinned}`, "  OTHER: value", ""].join("\n"),
  );
  return path;
}

const REGISTRY_HOST = "registry.example.invalid";
const PULL_USER = "pull-bot";
// A fake placeholder, never a working credential.
const PULL_TOKEN = "fake-pull-token-for-tests-0123";

/**
 * A `docker` that models a private registry. `buildx imagetools inspect`
 * answers with `body` only after a `docker login <host> --username <user>
 * --password-stdin` to REGISTRY_HOST with PULL_TOKEN on stdin; otherwise it
 * prints a registry refusal on stderr and fails. Every call's argv is logged
 * to argv.log, and what login read on stdin to login.log. A null body makes
 * the lookup fail even when logged in.
 */
function stubDocker(body, { credentials = true } = {}) {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "docker");
  const state = join(workdir, "state");
  mkdirSync(state, { recursive: true });
  const lines = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${state}/argv.log"`,
    'if [ "$1" = "login" ]; then',
    '  host=""; user=""; stdin_flag=no',
    "  shift",
    '  while [ $# -gt 0 ]; do',
    '    case "$1" in',
    '      --password-stdin) stdin_flag=yes ;;',
    '      --username|-u) user="$2"; shift ;;',
    '      --password|-p) echo "docker login: password on argv" >&2; exit 1 ;;',
    '      *) host="$1" ;;',
    "    esac",
    "    shift",
    "  done",
    '  [ "$stdin_flag" = yes ] || { echo "docker login: need --password-stdin" >&2; exit 1; }',
    `  [ "$host" = "${REGISTRY_HOST}" ] || { echo "login to wrong registry: $host" >&2; exit 1; }`,
    '  secret="$(cat)"',
    `  printf '%s' "$secret" > "${state}/login.log"`,
    `  [ "$user" = "${PULL_USER}" ] && [ "$secret" = "${PULL_TOKEN}" ] || { echo "unauthorized: incorrect username or password" >&2; exit 1; }`,
    `  : > "${state}/logged-in"`,
    "  echo 'Login Succeeded'",
    "  exit 0",
    "fi",
    'if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ]; then',
    `  if [ ! -e "${state}/logged-in" ]; then`,
    `    echo "ERROR: unauthorized: authentication required to read ${REGISTRY_HOST}" >&2`,
    "    exit 1",
    "  fi",
    ...(body === null
      ? ["  exit 1"]
      : ["  cat <<'IMAGE_EOF'", body, "IMAGE_EOF", "  exit 0"]),
    "fi",
    "exit 1",
    "",
  ];
  writeFileSync(stub, lines.join("\n"));
  chmodSync(stub, 0o755);
  const env = {
    ...process.env,
    SIGNING_IMAGE_NOW: NOW,
    PATH: `${binDir}:${process.env.PATH}`,
    ORBIT_BASE_IMAGE_REGISTRY: `${REGISTRY_HOST}/ai`,
  };
  delete env.ORBIT_BASE_IMAGE_PULL_USER;
  delete env.ORBIT_BASE_IMAGE_PULL_TOKEN;
  if (credentials) {
    env.ORBIT_BASE_IMAGE_PULL_USER = PULL_USER;
    env.ORBIT_BASE_IMAGE_PULL_TOKEN = PULL_TOKEN;
  }
  return env;
}

const imageCreated = (created) => JSON.stringify({ architecture: "amd64", os: "linux", created });

function run(env, ciFile) {
  return spawnSync("bash", [script, ciFile], { encoding: "utf8", env });
}

const pin = `${REGISTRY_HOST}/ai/orbit-base-image/signing@${digest(7)}`;
const output = (result) => `${result.stdout}${result.stderr}`;

describe("scripts/check-signing-image-age.sh (#1830)", () => {
  it("is silent about staleness for an image 13 days old", () => {
    const result = run(stubDocker(imageCreated("2026-11-01T13:00:00Z")), writeCiFile(pin));
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).not.toMatch(/warning/iu);
  });

  it("is silent for an image published today", () => {
    const result = run(stubDocker(imageCreated("2026-11-14T08:00:00Z")), writeCiFile(pin));
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).not.toMatch(/warning/iu);
  });

  it("warns at exactly 14 days", () => {
    const result = run(stubDocker(imageCreated("2026-10-31T12:00:00Z")), writeCiFile(pin));
    expect(result.status, output(result)).toBe(WARNING_EXIT);
    expect(output(result)).toMatch(/warning/iu);
  });

  it("warns for an image 40 days old, naming the digest, the age and orbit-base-image #33", () => {
    const result = run(stubDocker(imageCreated("2026-10-05T12:00:00Z")), writeCiFile(pin));
    expect(result.status, output(result)).toBe(WARNING_EXIT);
    expect(output(result)).toContain(digest(7));
    expect(output(result)).toMatch(/\b40 days\b/u);
    expect(output(result)).toContain("orbit-base-image #33");
  });

  it("honours SIGNING_IMAGE_MAX_AGE_DAYS", () => {
    const env = { ...stubDocker(imageCreated("2026-11-09T12:00:00Z")), SIGNING_IMAGE_MAX_AGE_DAYS: "5" };
    expect(run(env, writeCiFile(pin)).status).toBe(WARNING_EXIT);
  });

  it("warns, rather than staying silent, when the registry lookup fails", () => {
    const result = run(stubDocker(null), writeCiFile(pin));
    expect(result.status, output(result)).toBe(WARNING_EXIT);
    expect(output(result)).toMatch(/warning/iu);
    expect(output(result)).toMatch(/age|unreadable|could not/iu);
    expect(output(result)).toContain(digest(7));
    expect(output(result)).toContain("orbit-base-image #33");
  });

  it.each([
    ["no created field", JSON.stringify({ architecture: "amd64" })],
    ["an unparseable created field", imageCreated("not-a-date")],
    ["a non-JSON answer", "<html>oops</html>"],
    ["a created date in the future", imageCreated("2027-01-01T00:00:00Z")],
  ])("warns when the age is unreadable: %s", (_label, body) => {
    const result = run(stubDocker(body), writeCiFile(pin));
    expect(result.status, output(result)).toBe(WARNING_EXIT);
    expect(output(result)).toMatch(/warning/iu);
  });

  it("warns when the CI file pins no signing image", () => {
    const path = join(workdir, "empty.yml");
    writeFileSync(path, "variables:\n  OTHER: value\n");
    const result = run(stubDocker(imageCreated("2026-11-13T12:00:00Z")), path);
    expect(result.status, output(result)).toBe(WARNING_EXIT);
    expect(output(result)).toMatch(/warning/iu);
  });

  it("never fails with any code but 0 or the warning code, for stale, fresh or unreadable", () => {
    for (const body of [imageCreated("2020-01-01T00:00:00Z"), imageCreated("2026-11-14T00:00:00Z"), null]) {
      const status = run(stubDocker(body), writeCiFile(pin)).status;
      expect([0, WARNING_EXIT]).toContain(status);
    }
  });

  it("reads the pin the repository's own .gitlab-ci.yml carries", () => {
    const real = readFileSync(join(repoDir, ".gitlab-ci.yml"), "utf8").match(
      /^\s*ORBIT_SIGNING_IMAGE:\s*(\S+@sha256:[0-9a-f]{64})\s*$/mu,
    );
    expect(real).not.toBeNull();
    const result = run(stubDocker(imageCreated("2020-01-01T00:00:00Z")), join(repoDir, ".gitlab-ci.yml"));
    expect(result.status, output(result)).toBe(WARNING_EXIT);
    expect(output(result)).toContain(real[1].split("@")[1]);
  });

  // The signing image lives in orbit-base-image's private registry, so the
  // lookup needs the same read-only deploy login as build_image's pull
  // (.gitlab-ci.yml: ORBIT_BASE_IMAGE_PULL_USER/_TOKEN, password on stdin).
  describe("registry login", () => {
    const argvLog = () => {
      try {
        return readFileSync(join(workdir, "state", "argv.log"), "utf8");
      } catch {
        return "";
      }
    };

    it("logs in to the registry, then gives the right verdict (fresh)", () => {
      const result = run(stubDocker(imageCreated("2026-11-13T12:00:00Z")), writeCiFile(pin));
      expect(result.status, output(result)).toBe(0);
      expect(output(result)).toMatch(/\b1 days? old\b/u);
    });

    it("logs in to the registry, then gives the right verdict (stale)", () => {
      const result = run(stubDocker(imageCreated("2026-10-05T12:00:00Z")), writeCiFile(pin));
      expect(result.status, output(result)).toBe(WARNING_EXIT);
      expect(output(result)).toMatch(/\b40 days\b/u);
    });

    it("sends the password on stdin only, to the pin's registry host", () => {
      const env = stubDocker(imageCreated("2026-11-13T12:00:00Z"));
      run(env, writeCiFile(pin));
      const argv = argvLog();
      expect(argv).toMatch(new RegExp(`^login .*${REGISTRY_HOST}`, "mu"));
      expect(argv).toContain("--password-stdin");
      expect(argv).not.toContain(PULL_TOKEN);
      expect(readFileSync(join(workdir, "state", "login.log"), "utf8")).toBe(PULL_TOKEN);
    });

    it("never prints the password", () => {
      for (const body of [imageCreated("2026-11-13T12:00:00Z"), imageCreated("2026-10-05T12:00:00Z"), null]) {
        const result = run(stubDocker(body), writeCiFile(pin));
        expect(output(result)).not.toContain(PULL_TOKEN);
      }
    });

    it("exits 3 without credentials, saying the registry refused or no credentials were set", () => {
      const result = run(stubDocker(imageCreated("2026-11-13T12:00:00Z"), { credentials: false }), writeCiFile(pin));
      expect(result.status, output(result)).toBe(WARNING_EXIT);
      expect(output(result)).toMatch(/warning/iu);
      expect(output(result)).toMatch(/refused|not set|no credentials/iu);
      expect(output(result)).toMatch(/ORBIT_BASE_IMAGE_PULL/u);
    });

    it("does not hide the registry's own error when the lookup is refused", () => {
      const result = run(stubDocker(imageCreated("2026-11-13T12:00:00Z"), { credentials: false }), writeCiFile(pin));
      expect(output(result)).toContain("unauthorized: authentication required");
    });

    it("exits 3 and says so when the credentials are wrong", () => {
      const env = { ...stubDocker(imageCreated("2026-11-13T12:00:00Z")), ORBIT_BASE_IMAGE_PULL_TOKEN: "wrong-fake-token" };
      const result = run(env, writeCiFile(pin));
      expect(result.status, output(result)).toBe(WARNING_EXIT);
      expect(output(result)).toMatch(/refused|unauthorized|login/iu);
      expect(output(result)).not.toContain("wrong-fake-token");
    });
  });
});
