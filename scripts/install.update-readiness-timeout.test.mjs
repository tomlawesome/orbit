// The update readiness preflight is bounded (#1779, Orbit lead's review): a
// database that accepts the connection and then stalls must not hold the
// update before the engine. install.sh runs the one-off under
// `timeout ... 60s` (readonly update_readiness_timeout_seconds=60); expiry is
// exit 124, which ends the run as `update-readiness` / `retry` with a note
// that the check "did not finish within 60 s", before the engine, with
// nothing started. The fake docker has no hang switch, so a wrapper `timeout`
// first on PATH records each call and, for the preflight, simulates expiry
// (exit 124) without waiting; every other call goes to the real timeout.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { digest, eventLines, imageRepository, makeFakeBin, makePreprovisionedDeployment, makeTarget, revision, runInstall } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const TARGET = "v0.3.6";
const INSTALLED = "v0.3.5";
const RELEASES = ["v0.3.5", "v0.3.4", "v0.3.3", "v0.3.2"];
const TERMINAL = "phase=identity component=image state=failed reason=update-readiness action=retry";
const NOTE = "did not finish within 60 s";

function manifestFile() {
  const manifest = {
    schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
    version: TARGET,
    channel: "preview",
    commit: revision,
    updateFrom: RELEASES.slice(0, 3),
    releases: RELEASES,
    image: { repository: imageRepository, digest: `sha256:${digest}` },
    launcher: { tag: "v1.0.0", commit: revision },
    files: {},
    recordedAt: "2026-11-03T00:00:00Z",
  };
  const path = join(mkdtempSync(join(tmpdir(), "orbit-readiness-timeout-manifest-")), "orbit-release-manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

function installedFolder() {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir, [
    `ORBIT_IMAGE=${imageRepository}@sha256:${"c".repeat(64)}`,
    `ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"c".repeat(64)}`,
    `ORBIT_CONFIG_APPLIED_VERSION=${INSTALLED}`,
    "COMPOSE_PROJECT_NAME=orbit",
  ]);
  writeFileSync(join(targetDir, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(targetDir, ".orbit-secrets", "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  return targetDir;
}

/** Runs an update with a wrapper `timeout` first on PATH; `expire` makes the preflight's timeout expire (exit 124). */
function update({ expire }) {
  const wrapperDir = mkdtempSync(join(tmpdir(), "orbit-readiness-timeout-bin-"));
  const log = join(wrapperDir, "timeout.log");
  const realTimeout = ["/usr/bin/timeout", "/bin/timeout"].find((path) => existsSync(path));
  writeFileSync(
    join(wrapperDir, "timeout"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [[ "$*" == *"update --preflight"* && "${WRAPPER_EXPIRE:-}" == 1 ]]; then exit 124; fi',
      `exec ${realTimeout} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(wrapperDir, "timeout"), 0o755);
  const result = runInstall(
    installedFolder(),
    {
      PATH: `${wrapperDir}:${makeFakeBin()}:${process.env.PATH}`,
      WRAPPER_EXPIRE: expire ? "1" : "0",
      ORBIT_RELEASE_MANIFEST: manifestFile(),
      FAKE_DOCKER_VERSION: TARGET,
      FAKE_ENGINE_EXIT: "1",
      FAKE_READINESS_EXIT: "0",
    },
    ["--plain", "--update"],
  );
  const timeoutCalls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { ...result, timeoutCalls, preflightTimeouts: timeoutCalls.filter((line) => line.includes("update --preflight")) };
}

describe("install.sh --update: the readiness preflight is bounded (#1779)", () => {
  it("runs the preflight one-off under a 60 s timeout", () => {
    const result = update({ expire: false });
    expect(result.preflightTimeouts).toHaveLength(1);
    expect(result.preflightTimeouts[0]).toMatch(/(^| )60s /u);
    expect(result.preflightTimeouts[0]).toContain("run --rm --no-deps");
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.engineRuns, "the engine ran").toHaveLength(1);
  });

  it("when the bound expires (exit 124) fails as update-readiness retry before the engine, with nothing started", () => {
    const result = update({ expire: true });
    expect(result.preflightTimeouts).toHaveLength(1);
    expect(result.preflightTimeouts[0]).toMatch(/(^| )60s /u);
    expect(result.status).not.toBe(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(result.stderr).toContain(NOTE);
    expect(result.engineRuns, "the engine never ran").toHaveLength(0);
    expect(result.calls).not.toMatch(/^docker compose .* up\b/mu);
  });
});
