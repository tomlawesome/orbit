import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #536: proves the preflight refuses to run against a Compose project that
// already has running containers -- the exact shape of the reported defect,
// where `docker compose --env-file .env-orbit ...` with no `-p` silently
// adopted a real deployment's project and volumes. A fake `docker` on PATH
// stands in for both `docker compose ... config --format json` (project-name
// resolution) and `docker ps` (the running-containers check), so this needs
// no live daemon.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const lib = join(scriptsDir, "compose-isolation-preflight.sh");

let workdir;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "orbit-compose-preflight-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * A `docker` stub that answers `compose ... config --format json` with a
 * canned project name and `ps --filter label=com.docker.compose.project=...`
 * with a canned (possibly empty) list of running container names.
 */
function stubDockerOnPath({ projectName, runningContainers = [] }) {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir, { recursive: true });

  const configJson = join(workdir, "config.json");
  writeFileSync(configJson, JSON.stringify({ name: projectName }));
  const psOutput = join(workdir, "ps-output.txt");
  writeFileSync(psOutput, runningContainers.length > 0 ? `${runningContainers.join("\n")}\n` : "");

  const stub = join(binDir, "docker");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "compose" ]]; then
  for arg in "\$@"; do
    if [[ "\$arg" == "config" ]]; then
      cat "${configJson}"
      exit 0
    fi
  done
  echo "unexpected docker compose invocation: \$*" >&2
  exit 1
elif [[ "\${1:-}" == "ps" ]]; then
  cat "${psOutput}"
  exit 0
fi
echo "unexpected docker invocation: \$*" >&2
exit 1
`,
  );
  chmodSync(stub, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
}

function run(script, env) {
  return spawnSync("bash", ["-c", script], { encoding: "utf8", env });
}

describe("scripts/compose-isolation-preflight.sh", () => {
  it("resolves the project Compose would use, via `docker compose config`", () => {
    const env = stubDockerOnPath({ projectName: "orbit-demo" });
    const result = run(
      `source "${lib}" && resolve_compose_project .env-orbit -f docker-compose.yml`,
      env,
    );

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("orbit-demo");
  });

  it("refuses when containers are already running under the resolved project", () => {
    const env = stubDockerOnPath({
      projectName: "orbit-demo",
      runningContainers: ["orbit", "orbit-postgres"],
    });
    const result = run(
      `source "${lib}" &&
       project="$(resolve_compose_project .env-orbit -f docker-compose.yml)" &&
       compose_isolation_preflight "$project" "docker compose -p orbit-demo-unique --env-file .env-orbit -f docker-compose.yml up"`,
      env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to run against project 'orbit-demo'");
    expect(result.stderr).toContain("orbit");
    expect(result.stderr).toContain("orbit-postgres");
    expect(result.stderr).toContain("docker compose -p orbit-demo-unique --env-file .env-orbit -f docker-compose.yml up");
  });

  it("names the resolved project and the safe -p alternative in the refusal", () => {
    const env = stubDockerOnPath({
      projectName: "orbit",
      runningContainers: ["orbit-app"],
    });
    const result = run(
      `source "${lib}" &&
       project="$(resolve_compose_project .env-orbit)" &&
       compose_isolation_preflight "$project" "docker compose -p orbit-123 --env-file .env-orbit up"`,
      env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("project 'orbit'");
    expect(result.stderr).toContain("docker compose -p orbit-123 --env-file .env-orbit up");
  });

  it("passes silently when nothing is running under the resolved project", () => {
    const env = stubDockerOnPath({ projectName: "orbit-e2e-local-abcd1234-999", runningContainers: [] });
    const result = run(
      `source "${lib}" &&
       project="$(resolve_compose_project .env-orbit)" &&
       compose_isolation_preflight "$project" "unused" &&
       echo "preflight-passed: $project"`,
      env,
    );

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("preflight-passed: orbit-e2e-local-abcd1234-999");
  });

  it("refuses rather than guessing when the project cannot be resolved", () => {
    const env = stubDockerOnPath({ projectName: "", runningContainers: [] });
    const result = run(
      `source "${lib}" &&
       project="$(resolve_compose_project .env-orbit)" &&
       compose_isolation_preflight "$project" "unused"`,
      env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not resolve a Compose project name");
  });
});
