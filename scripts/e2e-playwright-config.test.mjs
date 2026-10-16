import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * tests/e2e/playwright.config.ts decides the project graph from
 * ORBIT_E2E_REUSE and ORBIT_E2E_QUARANTINE. The quarantine run must drop the
 * one-time "unclaimed" project (the gate has already claimed the stack) on
 * its own, without ORBIT_E2E_REUSE, because ORBIT_E2E_REUSE must not be set
 * for it: it would defeat the #1077 database guard.
 *
 * The config reads the environment when it is loaded, so each case loads a
 * fresh copy. tests/e2e/** is excluded from the vitest projects, hence this
 * lives in scripts/.
 */
const VARIABLES = ["ORBIT_E2E_REUSE", "ORBIT_E2E_QUARANTINE"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  vi.resetModules();
});

afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function loadProjects(env) {
  Object.assign(process.env, env);
  vi.resetModules();
  const config = (await import("../tests/e2e/playwright.config.ts")).default;
  const byName = new Map(config.projects.map((project) => [project.name, project]));
  return { names: [...byName.keys()], setup: byName.get("setup") };
}

describe("tests/e2e/playwright.config.ts project graph", () => {
  it("drops 'unclaimed' for a quarantine-only run without ORBIT_E2E_REUSE", async () => {
    const { names, setup } = await loadProjects({ ORBIT_E2E_QUARANTINE: "only" });
    expect(names).not.toContain("unclaimed");
    expect(setup.dependencies ?? []).not.toContain("unclaimed");
  });

  it("keeps 'unclaimed', and setup depending on it, when both variables are unset", async () => {
    const { names, setup } = await loadProjects({});
    expect(names).toContain("unclaimed");
    expect(setup.dependencies).toContain("unclaimed");
  });

  it("keeps 'unclaimed' for the gate run (quarantine excluded) with REUSE unset", async () => {
    const { names, setup } = await loadProjects({ ORBIT_E2E_QUARANTINE: "exclude" });
    expect(names).toContain("unclaimed");
    expect(setup.dependencies).toContain("unclaimed");
  });

  it("drops 'unclaimed' when ORBIT_E2E_REUSE=true", async () => {
    const { names, setup } = await loadProjects({ ORBIT_E2E_REUSE: "true" });
    expect(names).not.toContain("unclaimed");
    expect(setup.dependencies ?? []).not.toContain("unclaimed");
  });
});
