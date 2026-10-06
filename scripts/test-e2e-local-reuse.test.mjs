import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./test-e2e-local.sh", import.meta.url));

/*
 * #947: `--reuse PROJECT` skips the image build, the OIDC build and
 * `compose up`, identifying and health-checking an already-running stack by
 * Compose's own project/service labels instead. These drive the real script
 * past the dry-run hook -- discovery uses only read-only `docker ps`/`docker
 * inspect` calls, and a project name that certainly does not exist reaches
 * `fail()` before the script would ever touch pnpm, a build or `compose up`,
 * so this needs no Docker stub and starts nothing.
 *
 * They live in their own file because that is the granularity the docker
 * split works at (#950): the script's preconditions demand a real `docker`
 * binary and a reachable daemon, which the unprivileged `fast` lane has
 * neither of, so ORBIT_TEST_SKIP_DOCKER excludes this file there and
 * `fast_docker` runs it. The rest of test-e2e-local.test.mjs never gets past
 * the dry-run hook and so stays in `fast`, where it is cheaper.
 */
function runReuse(args) {
  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      // Deliberately no TEST_E2E_LOCAL_DRY_RUN: this must reach the real
      // --reuse discovery code, not the argument-assembly short-circuit.
      env: process.env,
      ...processGuard(),
    }),
    { label: "runReuse" },
  );
  // The script checks its whole prerequisite list -- docker, node, git, curl,
  // jq, openssl, pnpm -- several steps before the code under test, and the
  // teardown assertion below still passes on the output of a run that stopped
  // there, so the file would report half green having proven nothing. Assert
  // on the list as a whole rather than on `docker` alone: the first cut named
  // only docker and `fast_docker` then went red on jq instead (pipeline 1021),
  // which is the same silent-hole risk one package along (#947).
  expect(
    result.stderr,
    "this suite needs every prerequisite scripts/test-e2e-local.sh checks, not just docker: the lane running it must install them",
  ).not.toMatch(/missing prerequisite/);
  return result;
}

describe("test-e2e-local.sh --reuse", () => {
  it("fails loudly and exits non-zero when no stack exists for the named project", () => {
    const project = `orbit-e2e-local-reuse-test-absent-${process.pid}`;
    const result = runReuse(["--reuse", project]);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.stderr).toContain(project);
    expect(result.stderr).toContain("no running orbit-app container");
  });

  it("never tears down a stack it did not create, even when it fails to identify one", () => {
    const project = `orbit-e2e-local-reuse-test-absent-${process.pid}`;
    const result = runReuse(["--reuse", project]);
    expect(result.stderr).toContain("not tearing down project");
    // The positive form ("tearing down project ...", no "not") is only ever
    // logged right before a real `compose down` call, so its absence here is
    // the proof that call never happened.
    expect(result.stderr).not.toMatch(/(?<!not )tearing down project/);
  });
});
