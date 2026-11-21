// scripts/install.sh --update checks the running database before it replaces
// anything (#1779, design note 58520 build note B, installer guarantee 69):
// `check_update_readiness`, after the digest is pulled and verified and before
// `run_engine`, runs the new image's `orbit update --preflight` as a compose
// one-off (restore.sh's E3a shape). Only an update runs it; only a database
// that answers pg_isready is asked. Exit 1 is the engine's refusal, any other
// failure is "could not check"; both are
// `fail_with update-readiness retry`, before the engine. Written from the
// note alone, before the change. Fixtures: install-test-support.mjs, whose
// fake docker records the one-off in readiness-oneoff.jsonl.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { digest, eventLines, imageRepository, makePreprovisionedDeployment, makeTarget, revision, runInstall } from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const TARGET = "v0.3.6";
const INSTALLED = "v0.3.5";
const RELEASES = ["v0.3.5", "v0.3.4", "v0.3.3", "v0.3.2"];
const TERMINAL = "phase=identity component=image state=failed reason=update-readiness action=retry";
const SKIP_LINE = "Orbit installer: the database did not answer its health check, so the update readiness check will run when Orbit starts.";
const COULD_NOT_CHECK = "Orbit installer: Orbit could not check whether the database is ready for this release; see the lines above.";
const BLOCKED = "update-preflight: blocked documents.content_sha256 rows=12";
const REMEDY = "Orbit is still moving documents under the household key; run the update again later.";
const RESOLVED = `${imageRepository}@sha256:${digest}`;

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
  const path = join(mkdtempSync(join(tmpdir(), "orbit-update-readiness-manifest-")), "orbit-release-manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

/** An installed deployment: the applied stamp and version, a compose file, and the household key unless `key` is false. */
function installedFolder({ key = true } = {}) {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir, [
    `ORBIT_IMAGE=${imageRepository}@sha256:${"c".repeat(64)}`,
    `ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"c".repeat(64)}`,
    `ORBIT_CONFIG_APPLIED_VERSION=${INSTALLED}`,
    "COMPOSE_PROJECT_NAME=orbit",
  ]);
  writeFileSync(join(targetDir, "docker-compose.yml"), "services: {}\n");
  if (key) writeFileSync(join(targetDir, ".orbit-secrets", "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  return targetDir;
}

function update(options = {}, extraEnv = {}) {
  return runInstall(installedFolder(options), { ORBIT_RELEASE_MANIFEST: manifestFile(), FAKE_DOCKER_VERSION: TARGET, FAKE_ENGINE_EXIT: "1", ...extraEnv }, ["--plain", "--update"]);
}

const orbitLines = (stderr) => stderr.split("\n").filter((line) => line.startsWith("Orbit installer: "));
const preflightCalls = (result) => result.calls.split("\n").filter((line) => line.includes("update --preflight"));
const pulledBeforeRefusal = (result) => /^docker pull /mu.test(result.calls);

describe("install.sh --update: the update readiness check (#1779, guarantee 69)", () => {
  it("never runs the one-off on a fresh install", () => {
    const result = runInstall(makeTarget(), { FAKE_READINESS_EXIT: "1", FAKE_ENGINE_EXIT: "1" }, ["--plain"]);
    expect(preflightCalls(result)).toEqual([]);
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.stderr).not.toContain(SKIP_LINE);
  });

  it("runs the one-off once on an update with the database answering, and goes on to the engine when it exits 0", () => {
    const result = update({}, { FAKE_READINESS_EXIT: "0", FAKE_READINESS_STDOUT: "update-preflight: ready\n" });
    expect(preflightCalls(result)).toHaveLength(1);
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.engineRuns, "the engine ran").toHaveLength(1);
  });

  it("with pg_isready failing, prints the skip line, runs no one-off, and reaches the engine", () => {
    const result = update({}, { FAKE_PROBE_FAIL: "orbit-db" });
    expect(orbitLines(result.stderr)).toContain(SKIP_LINE);
    expect(result.stderr).not.toContain("the database is not running");
    expect(preflightCalls(result)).toEqual([]);
    expect(result.stdout).not.toContain("reason=update-readiness");
    expect(result.engineRuns).toHaveLength(1);
  });

  it("exit 1 ends the run before the engine with reason=update-readiness action=retry and the engine's own text", () => {
    const result = update({}, { FAKE_READINESS_EXIT: "1", FAKE_READINESS_STDOUT: `${BLOCKED}\n${REMEDY}\n` });
    expect(result.status).not.toBe(0);
    expect(result.engineRuns, "the engine never ran").toHaveLength(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(result.stderr).toContain(BLOCKED);
    expect(result.stderr).toContain(REMEDY);
    expect(result.stderr).not.toContain(COULD_NOT_CHECK);
    expect(result.calls).not.toMatch(/^docker compose .* (up|down|pull)\b/mu);
  });

  it("exit 2 ends it the same way with the could-not-check text", () => {
    const result = update({}, { FAKE_READINESS_EXIT: "2", FAKE_READINESS_STDERR: "orbit: the database could not be reached.\n" });
    expect(result.status).not.toBe(0);
    expect(result.engineRuns).toHaveLength(0);
    expect(eventLines(result.stdout).filter((event) => event.startsWith(TERMINAL))).toHaveLength(1);
    expect(orbitLines(result.stderr)).toContain(COULD_NOT_CHECK);
    expect(result.stderr).toContain("orbit: the database could not be reached.");
  });

  it.each([["3"], ["125"], ["137"]])("any other failure (exit %s) is the could-not-check refusal, never a pass", (code) => {
    const result = update({}, { FAKE_READINESS_EXIT: code });
    expect(result.status).not.toBe(0);
    expect(result.engineRuns).toHaveLength(0);
    expect(orbitLines(result.stderr)).toContain(COULD_NOT_CHECK);
    expect(result.stdout).toContain(TERMINAL);
  });

  it("changes nothing before it refuses: the image was pulled, the deployment was not touched", () => {
    const targetDir = installedFolder();
    const before = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    const result = runInstall(targetDir, { ORBIT_RELEASE_MANIFEST: manifestFile(), FAKE_DOCKER_VERSION: TARGET, FAKE_ENGINE_EXIT: "1", FAKE_READINESS_EXIT: "1", FAKE_READINESS_STDOUT: `${BLOCKED}\n` }, ["--plain", "--update"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(TERMINAL);
    expect(pulledBeforeRefusal(result)).toBe(true);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(before);
  });

  describe("the one-off's command line", () => {
    it("carries the resolved digest in ORBIT_IMAGE, --no-deps, and update --preflight --dir /orbit-deploy on the orbit-app service", () => {
      const result = update({ key: true }, { FAKE_READINESS_EXIT: "0" });
      const [call] = result.oneOffs;
      expect(call, "the one-off ran").toBeDefined();
      expect(call.orbitImage).toBe(RESOLVED);
      expect(call.argv).toContain("--no-deps");
      expect(call.argv).toContain("run");
      expect(call.argv).toContain("--rm");
      const line = call.argv.join(" ");
      expect(line).toContain("--entrypoint node orbit-app /opt/orbit/cli/orbit.js update --preflight --dir /orbit-deploy");
      expect(line).toMatch(/--entrypoint node/u);
    });

    it("leaves out the no-key overlay when .orbit-secrets/document-kek exists", () => {
      const result = update({ key: true }, { FAKE_READINESS_EXIT: "0" });
      const [call] = result.oneOffs;
      expect(call).toBeDefined();
      expect(`${call.argv.join(" ")} ${call.composeFile ?? ""}`).not.toContain("docker-compose.no-document-key.yml");
    });

    it("adds docker-compose.no-document-key.yml, as restore.sh does, when .orbit-secrets/document-kek is missing", () => {
      const result = update({ key: false }, { FAKE_READINESS_EXIT: "0" });
      const [call] = result.oneOffs;
      expect(call).toBeDefined();
      expect(`${call.argv.join(" ")} ${call.composeFile ?? ""}`).toContain("docker-compose.no-document-key.yml");
    });
  });
});
