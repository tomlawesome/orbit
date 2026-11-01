import { readFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1614, ADR-0039: web/playwright.config.js gains the rig, five projects for
 * the browsers and sizes the front end is judged on, beside the projects the
 * visual gate and the measurements already use. The repo-root config for the
 * stack suite is covered by e2e-playwright-config.test.mjs; this file covers
 * the web one.
 *
 * The config reads ORBIT_RIG_WORKERS when it is loaded, so each case loads a
 * fresh copy. tests/e2e/** and web/** are not vitest projects of their own,
 * hence this lives in scripts/.
 */
const web = fileURLToPath(new URL("../web/", import.meta.url));
const RIG = ["rig-desktop", "rig-phone", "rig-firefox", "rig-webkit-desktop", "rig-webkit-phone"];
const UNCHANGED = ["fidelity", "pocket-measure", "pocket-webkit", "launch-timing", "door-timing"];

let saved;
beforeEach(() => {
  saved = process.env.ORBIT_RIG_WORKERS;
  delete process.env.ORBIT_RIG_WORKERS;
  vi.resetModules();
});
afterEach(() => {
  if (saved === undefined) delete process.env.ORBIT_RIG_WORKERS;
  else process.env.ORBIT_RIG_WORKERS = saved;
});

async function loadConfig(env = {}) {
  Object.assign(process.env, env);
  vi.resetModules();
  const config = (await import("../web/playwright.config.js")).default;
  const byName = new Map(config.projects.map((project) => [project.name, project]));
  return { config, byName };
}

// A project's own setting wins over the config's.
const setting = (config, project, key) => project[key] ?? config[key];

describe("web/playwright.config.js rig projects", () => {
  it("has the five rig projects", async () => {
    const { byName } = await loadConfig();
    for (const name of RIG) expect(byName.has(name), name).toBe(true);
  });

  it("points every rig project at web/tests/rig", async () => {
    const { config, byName } = await loadConfig();
    for (const name of RIG) {
      const testDir = setting(config, byName.get(name), "testDir");
      expect(resolve(web, testDir), name).toBe(resolve(web, "tests/rig"));
    }
  });

  it("runs every rig project fully parallel", async () => {
    const { config, byName } = await loadConfig();
    for (const name of RIG) expect(setting(config, byName.get(name), "fullyParallel"), name).toBe(true);
  });

  it("takes the rig workers from ORBIT_RIG_WORKERS", async () => {
    const { config, byName } = await loadConfig({ ORBIT_RIG_WORKERS: "3" });
    for (const name of RIG) expect(setting(config, byName.get(name), "workers"), name).toBe(3);
  });

  it("defaults the rig workers to half the CPUs, at least two", async () => {
    const { config, byName } = await loadConfig();
    const expected = Math.max(2, Math.floor(os.cpus().length / 2));
    for (const name of RIG) expect(setting(config, byName.get(name), "workers"), name).toBe(expected);
  });

  it("runs the engines the names promise", async () => {
    const { byName } = await loadConfig();
    const engine = (name) => byName.get(name).use?.browserName ?? "chromium";
    expect(engine("rig-desktop")).toBe("chromium");
    expect(engine("rig-phone")).toBe("chromium");
    expect(engine("rig-firefox")).toBe("firefox");
    expect(engine("rig-webkit-desktop")).toBe("webkit");
    expect(engine("rig-webkit-phone")).toBe("webkit");
  });

  it("gives the phone projects a touch phone viewport and the desktop ones a wide one", async () => {
    const { byName } = await loadConfig();
    for (const name of ["rig-phone", "rig-webkit-phone"]) {
      const use = byName.get(name).use;
      expect(use.isMobile, name).toBe(true);
      expect(use.hasTouch, name).toBe(true);
      expect(use.viewport.width, name).toBeLessThan(500);
    }
    for (const name of ["rig-desktop", "rig-webkit-desktop", "rig-firefox"]) {
      const use = byName.get(name).use;
      expect(use?.isMobile ?? false, name).toBe(false);
      // The top-level `use` is the 1600x1000 design viewport when a project sets none.
      expect(use?.viewport?.width ?? 1600, name).toBeGreaterThanOrEqual(1024);
    }
  });

  it("keeps the existing projects", async () => {
    const { byName } = await loadConfig();
    for (const name of UNCHANGED) expect(byName.has(name), name).toBe(true);
    expect(byName.get("fidelity").workers).toBe(1);
    expect(byName.get("pocket-measure").workers).toBe(4);
    expect(byName.get("pocket-webkit").testMatch).toEqual([
      "**/tour-pocket-webkit.spec.js",
      "**/pocket-belong-drawer.spec.js",
    ]);
  });

  it("shares the existing web servers, with the fixtures on", async () => {
    const { config } = await loadConfig();
    expect(config.webServer).toHaveLength(2);
    expect(config.webServer[0].env.ORBIT_FIXTURES).toBe("1");
  });
});

/*
 * The four package scripts. A script may name its projects itself
 * (--project=NAME or --project NAME) or call another script (pnpm rig:webkit);
 * both are followed so the test pins what runs, not how it is written.
 */
const { scripts } = JSON.parse(readFileSync(new URL("package.json", `file://${web}`), "utf8"));

function projectsOf(name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const text = scripts[name];
  const projects = new Set([...text.matchAll(/--project[= ]([\w-]+)/g)].map((m) => m[1]));
  for (const m of text.matchAll(/\bpnpm (?:run )?(rig[\w:]*)/g)) {
    if (scripts[m[1]]) for (const p of projectsOf(m[1], seen)) projects.add(p);
  }
  return projects;
}

describe("web/package.json rig scripts", () => {
  const cases = [
    ["rig", ["rig-desktop", "rig-phone"]],
    ["rig:firefox", ["rig-firefox"]],
    ["rig:webkit", ["rig-webkit-desktop", "rig-webkit-phone"]],
    ["rig:all", RIG],
  ];
  for (const [name, projects] of cases) {
    it(`${name} exists and runs exactly ${projects.join(", ")}`, () => {
      expect(scripts[name], `no "${name}" script`).toBeTypeOf("string");
      expect(scripts[name]).toMatch(/playwright test|\bpnpm (?:run )?rig/);
      expect([...projectsOf(name)].sort()).toEqual([...projects].sort());
    });
  }
});
