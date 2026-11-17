// #1861 items 1 and 2: the test shims run a CLI bundle built once per Vitest
// run (not tsx per engine call), and the prune test builds its installed
// folder once in beforeAll instead of running `install.sh --install` per test.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeEngineDockerShim } from "./engine-docker-shim.mjs";
import { fakeDockerScript } from "./install-test-support.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(repoRoot, "dist");
const PRELOAD = "test-engine-container-stdio.cjs";
const BUNDLE_PATH = /["'`]([^"'`\s]+\.c?js)["'`]/gu;

let binDir;
beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "orbit-shim-1861-"));
});
afterAll(() => rmSync(binDir, { recursive: true, force: true }));

const shims = () => {
  const engine = readFileSync(writeEngineDockerShim(binDir), "utf8");
  return { "engine-docker-shim.mjs": engine, "install-test-support.mjs fakeDockerScript": fakeDockerScript };
};

/** The bundle the shim runs: a .js/.cjs path in its text, else the env var the globalSetup is expected to set. */
function bundleOf(text) {
  const found = [...text.matchAll(BUNDLE_PATH)].map((m) => m[1]).filter((p) => p.startsWith("/") && !p.includes("/opt/orbit/") && !p.endsWith(PRELOAD));
  return found[0] ?? process.env.ORBIT_TEST_CLI_BUNDLE;
}

describe("#1861 item 1: the docker shims run a bundle, not tsx", () => {
  for (const name of ["engine-docker-shim.mjs", "install-test-support.mjs fakeDockerScript"]) {
    it(`${name} does not reference tsx or src/cli/orbit.ts`, () => {
      const text = shims()[name];
      expect(text).not.toMatch(/tsx/u);
      expect(text).not.toContain("src/cli/orbit.ts");
      expect(text).not.toMatch(/src[\\/]cli[\\/]orbit/u);
    });

    it(`${name} preloads ${PRELOAD} with --require`, () => {
      expect(shims()[name]).toMatch(/--require["'`,\s]+[^"'`\n]*test-engine-container-stdio\.cjs/u);
    });

    it(`${name} runs a .js/.cjs bundle outside dist/ and inside a temporary directory`, () => {
      const bundle = bundleOf(shims()[name]);
      expect(bundle, "no bundle path in the shim text or ORBIT_TEST_CLI_BUNDLE").toBeTruthy();
      expect(bundle).toMatch(/\.c?js$/u);
      const abs = resolve(bundle);
      expect(abs.startsWith(distDir + sep)).toBe(false);
      const tmp = resolve(tmpdir());
      expect(relative(tmp, abs).startsWith("..")).toBe(false);
      expect(abs.startsWith(tmp + sep)).toBe(true);
    });
  }

  it("the bundle exists and `--help` exits and prints as the tsx form does", () => {
    const bundle = bundleOf(shims()["engine-docker-shim.mjs"]);
    expect(bundle, "no bundle path").toBeTruthy();
    expect(existsSync(bundle)).toBe(true);
    const viaBundle = spawnSync("node", [bundle, "--help"], { encoding: "utf8" });
    const viaTsx = spawnSync(
      "node",
      [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(repoRoot, "src", "cli", "orbit.ts"), "--help"],
      { encoding: "utf8" },
    );
    expect(viaBundle.status).toBe(viaTsx.status);
    expect(viaBundle.stderr + viaBundle.stdout).toBe(viaTsx.stderr + viaTsx.stdout);
  }, 30_000);

  it("vitest.config.ts gives the scripts project a globalSetup", () => {
    const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/globalSetup/u);
  });
});

describe("#1861 item 2: install.update-prune-undo-copies builds its installed folder once", () => {
  const source = readFileSync(join(repoRoot, "scripts", "install.update-prune-undo-copies.test.mjs"), "utf8");

  it("runs `--install` only inside a beforeAll", () => {
    const hooks = [];
    for (const m of source.matchAll(/beforeAll\s*\(/gu)) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")" && --depth === 0) break;
      }
      hooks.push([start, i]);
    }
    expect(hooks.length, "no beforeAll in the file").toBeGreaterThan(0);
    const installs = [...source.matchAll(/["'`]--install["'`]/gu)].map((m) => m.index);
    expect(installs.length).toBeGreaterThan(0);
    for (const at of installs) {
      expect(hooks.some(([s, e]) => at > s && at < e), `--install at offset ${at} is outside a beforeAll`).toBe(true);
    }
  });
});
