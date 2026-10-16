import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvedComposeProject } from "../tests/e2e/support/database.ts";

/*
 * #1077: tests/e2e/support/database.ts truncates and restores every table in
 * `public`, so it refuses to run against a Compose project that is not
 * provably the suite's own. ORBIT_E2E_REUSE only tells playwright.config.ts
 * that the stack is already claimed (so the "unclaimed" project is dropped);
 * it must NOT also vouch for the project, because the quarantine runs of
 * scripts/test-frontend.sh and scripts/test-e2e-local.sh used to set it, and a
 * local quarantine run with COMPOSE_PROJECT_NAME=orbit (a real install) would
 * then reset that real database. Ownership is ORBIT_E2E_OWNED_PROJECT, or the
 * orbit-e2e-local- shape, or CI with no project at all.
 *
 * tests/e2e/** is excluded from the vitest projects, so the guard is tested
 * here, from scripts/, by importing the module.
 */
const VARIABLES = ["COMPOSE_PROJECT_NAME", "ORBIT_E2E_REUSE", "ORBIT_E2E_OWNED_PROJECT", "CI"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
});

afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("resolvedComposeProject (#1077)", () => {
  it("refuses a real install's project even when ORBIT_E2E_REUSE=true", () => {
    process.env.COMPOSE_PROJECT_NAME = "orbit";
    process.env.ORBIT_E2E_REUSE = "true";
    expect(() => resolvedComposeProject()).toThrow(/#1077/);
  });

  it("refuses a real install's project when nothing vouches for it", () => {
    process.env.COMPOSE_PROJECT_NAME = "orbit";
    expect(() => resolvedComposeProject()).toThrow(/#1077/);
  });

  it("accepts a project named by ORBIT_E2E_OWNED_PROJECT", () => {
    process.env.COMPOSE_PROJECT_NAME = "my-stack";
    process.env.ORBIT_E2E_OWNED_PROJECT = "my-stack";
    expect(resolvedComposeProject()).toBe("my-stack");
  });

  it("refuses a project that is not the one ORBIT_E2E_OWNED_PROJECT names", () => {
    process.env.COMPOSE_PROJECT_NAME = "orbit";
    process.env.ORBIT_E2E_OWNED_PROJECT = "my-stack";
    expect(() => resolvedComposeProject()).toThrow(/#1077/);
  });

  it("accepts the orbit-e2e-local- shape the script derives", () => {
    process.env.COMPOSE_PROJECT_NAME = "orbit-e2e-local-abc-123";
    expect(resolvedComposeProject()).toBe("orbit-e2e-local-abc-123");
  });

  it("returns undefined in CI with no project name", () => {
    process.env.CI = "true";
    expect(resolvedComposeProject()).toBeUndefined();
  });

  it("refuses an unset project name outside CI", () => {
    expect(() => resolvedComposeProject()).toThrow(/#1077/);
  });
});
