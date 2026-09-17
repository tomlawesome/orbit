import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #731: --project is variadic in the pinned Playwright, so `--project NAME
// SPEC` reads SPEC as a second project name instead of a file filter. This
// drives the real script (not a text match on its source) with
// TEST_E2E_LOCAL_DRY_RUN=1, a hook that prints the assembled
// `playwright_args` array and exits before any Docker or network work runs
// -- so the combination is proven without bringing up the acceptance stack.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = fileURLToPath(new URL("./test-e2e-local.sh", import.meta.url));

function dryRunArgsRaw(args) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, TEST_E2E_LOCAL_DRY_RUN: "1" },
      ...processGuard(),
    }),
    { label: "dryRunArgs" },
  );
}

function dryRunArgs(args) {
  const result = dryRunArgsRaw(args);
  expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

// The two --reuse tests that drive the real discovery code, and so need a
// real docker binary, live in test-e2e-local-reuse.test.mjs: `fast` has no
// docker, `fast_docker` does (#950). Only argument handling is tested here,
// which the dry-run hook answers before the script checks its preconditions.
describe("test-e2e-local.sh --reuse", () => {
  it("accepts a value without disturbing Playwright argument assembly", () => {
    expect(dryRunArgs(["--reuse", "some-project"])).toEqual(dryRunArgs([]));
  });

  it("requires a value", () => {
    const result = dryRunArgsRaw(["--reuse"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--reuse requires a Compose project name");
  });
});

describe("test-e2e-local.sh Playwright argument assembly", () => {
  it("keeps the spec out of --project's value when both flags are given", () => {
    const args = dryRunArgs([
      "--spec",
      "tests/e2e/v19-hit-routing.spec.ts",
      "--project",
      "desktop-chromium",
    ]);
    expect(args).toEqual(["--project=desktop-chromium", "tests/e2e/v19-hit-routing.spec.ts"]);
  });

  it("keeps the spec out of --project's value regardless of flag order", () => {
    const args = dryRunArgs([
      "--project",
      "mobile-chromium",
      "--spec",
      "tests/e2e/v19-hit-routing.spec.ts",
    ]);
    expect(args).toEqual(["--project=mobile-chromium", "tests/e2e/v19-hit-routing.spec.ts"]);
  });

  it("passes --project alone", () => {
    const args = dryRunArgs(["--project", "desktop-chromium"]);
    expect(args).toEqual(["--project=desktop-chromium"]);
  });

  it("passes --spec alone", () => {
    const args = dryRunArgs(["--spec", "tests/e2e/v19-hit-routing.spec.ts"]);
    expect(args).toEqual(["tests/e2e/v19-hit-routing.spec.ts"]);
  });

  it("passes neither flag", () => {
    expect(dryRunArgs([])).toEqual([]);
  });
});

/*
 * #916: the second acceptance profile. Its whole point is that one short list
 * of specs runs against a provider-less stack, and that the same list is what
 * the `smoke_local_only` job in .gitlab-ci.yml runs -- so the list is a file
 * both read rather than a phrase each repeats. These drive the real script,
 * the same way as above, so the list is proven to reach Playwright's argument
 * vector rather than merely to exist.
 */
const localOnlySpecs = readFileSync(
  fileURLToPath(new URL("../tests/e2e/local-only-specs.txt", import.meta.url)),
  "utf8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("the local-only profile", () => {
  it("names at least one spec, so the lane cannot silently run nothing", () => {
    expect(localOnlySpecs.length).toBeGreaterThan(0);
  });

  it("runs the shared list when no --spec narrows it", () => {
    expect(dryRunArgs(["--profile", "local-only"])).toEqual(localOnlySpecs);
  });

  it("keeps the list behind an explicit --project, in that order", () => {
    expect(dryRunArgs(["--profile", "local-only", "--project", "desktop-chromium"]))
      .toEqual(["--project=desktop-chromium", ...localOnlySpecs]);
  });

  it("lets an explicit --spec override the list", () => {
    expect(dryRunArgs(["--profile", "local-only", "--spec", "tests/e2e/local-sign-in.spec.ts"]))
      .toEqual(["tests/e2e/local-sign-in.spec.ts"]);
  });

  it("changes nothing for the default profile", () => {
    expect(dryRunArgs(["--profile", "oidc"])).toEqual([]);
  });

  it("refuses a profile it does not have a stack for", () => {
    const result = spawnSync("bash", [script, "--profile", "provider-less"], {
      encoding: "utf8",
      env: { ...process.env, TEST_E2E_LOCAL_DRY_RUN: "1" },
      ...processGuard(),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown profile");
  });
});

/*
 * #920: this harness's claim is that a local run judges the journeys CI
 * judges, and it silently did not -- the document parser was never turned
 * on, so tests/e2e/v19-document-extraction.spec.ts failed locally with the
 * product's "the optional document processor" message while passing in CI.
 * CI turns it on in scripts/ci/create-test-configuration.sh, which appends
 * the profile and the parser's address to .env-orbit. This script must never
 * write to .env-orbit, so it carries the same two values by its own route:
 * the profile through COMPOSE_PROFILES on its compose() wrapper, the address
 * through compose/docker-compose.local-e2e.yml. Read CI's values rather than
 * repeating them, so moving CI's pair cannot leave the local pair behind --
 * the same "one source both lanes read" shape as local-only-specs.txt above.
 */
const ciTestConfiguration = readFileSync(
  fileURLToPath(new URL("./ci/create-test-configuration.sh", import.meta.url)),
  "utf8",
);
const scriptSource = readFileSync(script, "utf8");
const localE2eOverlay = readFileSync(
  fileURLToPath(new URL("../compose/docker-compose.local-e2e.yml", import.meta.url)),
  "utf8",
);

function ciAppendedValue(key) {
  const match = ciTestConfiguration.match(new RegExp(`'${key}=([^']*)'`));
  expect(match, `scripts/ci/create-test-configuration.sh no longer appends ${key}`).not.toBeNull();
  return match[1];
}

describe("the document parser the local stack runs", () => {
  it("selects the same Compose profile CI does", () => {
    expect(scriptSource).toContain(`COMPOSE_PROFILES=${ciAppendedValue("COMPOSE_PROFILES")}`);
  });

  it("points the application at the same parser address CI does", () => {
    expect(localE2eOverlay).toContain(`TIKA_URL: ${ciAppendedValue("TIKA_URL")}`);
  });
});
