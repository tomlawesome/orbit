import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * scripts/test-frontend.sh hands Playwright its quarantine selection through
 * ORBIT_E2E_QUARANTINE. The quarantine run must NOT also export
 * ORBIT_E2E_REUSE: that variable used to switch off the #1077 database guard
 * in tests/e2e/support/database.ts, so a local quarantine run against a real
 * install (COMPOSE_PROJECT_NAME=orbit) would have reset that database.
 *
 * These run the real script with stubs for `pnpm` and `curl` first on PATH
 * (the script launches Playwright through pnpm, and health-checks with curl),
 * the stub recording the environment it was started with. Nothing real runs.
 */
const script = fileURLToPath(new URL("./test-frontend.sh", import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runScript(args, scriptPath = script, { env: extraEnv = {}, curlExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "test-frontend-"));
  fixtures.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const envLog = join(dir, "playwright-env.txt");
  const argsLog = join(dir, "playwright-args.txt");
  // Records the stub's whole environment, one NAME=value per line (NUL
  // separated, so a value with a newline cannot forge a line), and its
  // arguments, NUL separated the same way (#1614: the specs the script names).
  const stub = `#!/usr/bin/env bash\nenv -0 > "$ENV_LOG"\nprintf '%s\\0' "$@" > "$ARGS_LOG"\nexit 0\n`;
  for (const name of ["pnpm", "curl"]) {
    writeFileSync(join(bin, name), name === "pnpm" ? stub : `#!/usr/bin/env bash\nexit ${curlExit}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return new Promise((resolve, reject) => {
    // Stdin stays open (a pipe nobody closes until the child is gone): a
    // closed stdin is not what a terminal run looks like.
    const child = spawn("bash", [scriptPath, ...args], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        ENV_LOG: envLog,
        ARGS_LOG: argsLog,
        PLAYWRIGHT_BASE_URL: "http://127.0.0.1:1",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => (stdout += d));
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`killed on a deadline of ${PROCESS_DEADLINE_MS}ms\nstderr: ${stderr}`));
    }, PROCESS_DEADLINE_MS);
    child.on("close", (status) => {
      clearTimeout(deadline);
      child.stdin.destroy();
      let recorded = null;
      try {
        recorded = Object.fromEntries(
          readFileSync(envLog, "utf8")
            .split("\0")
            .filter((entry) => entry.includes("="))
            .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
        );
      } catch {}
      let args = null;
      try {
        args = readFileSync(argsLog, "utf8").split("\0").slice(0, -1);
      } catch {}
      resolve({ status, stderr, stdout, env: recorded, args });
    });
  });
}

describe("scripts/test-frontend.sh quarantine selection", () => {
  it("--quarantine selects only quarantined tests and does not export ORBIT_E2E_REUSE", async () => {
    const result = await runScript(["--quarantine"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.env, "the Playwright stub was never started").not.toBeNull();
    expect(result.env.ORBIT_E2E_QUARANTINE).toBe("only");
    expect(Object.keys(result.env)).not.toContain("ORBIT_E2E_REUSE");
  });

  it("without --quarantine excludes quarantined tests", async () => {
    const result = await runScript([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.env, "the Playwright stub was never started").not.toBeNull();
    expect(result.env.ORBIT_E2E_QUARANTINE).toBe("exclude");
    expect(Object.keys(result.env)).not.toContain("ORBIT_E2E_REUSE");
  });
});

/*
 * scripts/check-quarantine.mjs (exit 1 when an @quarantine tag is not on
 * tests/quarantine.txt) must run before the gate. These run the real script
 * and the real check from a copy of the tree under a temporary root: only
 * the two scripts are copied, plus a spec holding an @quarantine tag, so the
 * wiring is tested rather than a stand-in. Playwright is the pnpm stub, which
 * records its environment only if started.
 */
function quarantineRoot({ listed }) {
  const root = mkdtempSync(join(tmpdir(), "test-frontend-root-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests", "e2e"), { recursive: true });
  for (const name of ["test-frontend.sh", "check-quarantine.mjs"]) {
    copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(root, "scripts", name));
  }
  writeFileSync(join(root, "tests", "e2e", "x.spec.ts"), 'test("a thing", { tag: "@quarantine" }, async () => {});\n');
  if (listed) writeFileSync(join(root, "tests", "quarantine.txt"), "tests/e2e/x.spec.ts 1 #1\n");
  return join(root, "scripts", "test-frontend.sh");
}

describe("scripts/test-frontend.sh quarantine list check", () => {
  it("without --quarantine, a failing check exits non-zero and Playwright is never launched", async () => {
    const result = await runScript([], quarantineRoot({ listed: false }));
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("quarantine list");
    expect(result.env, "Playwright was launched after the check failed").toBeNull();
  });

  it("without --quarantine, a passing check lets Playwright run", async () => {
    const result = await runScript([], quarantineRoot({ listed: true }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.env, "the Playwright stub was never started").not.toBeNull();
    expect(result.env.ORBIT_E2E_QUARANTINE).toBe("exclude");
  });

  it("--quarantine does not require the check", async () => {
    const result = await runScript(["--quarantine"], quarantineRoot({ listed: false }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.env, "the Playwright stub was never started").not.toBeNull();
    expect(result.env.ORBIT_E2E_QUARANTINE).toBe("only");
  });
});

/*
 * #1614, ADR-0039 section 4: the stack suite no longer runs every engine. WebKit
 * runs only the sign-in sliver, the specs listed in
 * tests/e2e/webkit-sliver-specs.txt, because the rest of the WebKit checking
 * moved to the rig (web/playwright.config.js). Firefox runs the rig alone, so
 * for ORBIT_E2E_ENGINES=firefox the script has nothing to run and says so.
 * Chromium, or no engine named, runs the whole suite exactly as before.
 *
 * The list is read from the real file in the real tree; the specs are named
 * to Playwright as positional arguments after `test:e2e`, which Playwright
 * treats as file filters. The pnpm stub records them.
 */
const sliverList = fileURLToPath(new URL("../tests/e2e/webkit-sliver-specs.txt", import.meta.url));
const SLIVER = ["v19-entry.spec.ts", "local-sign-in.spec.ts", "v19-first-run-door.spec.ts"];

// An entry may carry its directory (local-only-specs.txt does); the name is
// what identifies the spec.
function listedSpecs(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => basename(line));
}

describe("tests/e2e/webkit-sliver-specs.txt", () => {
  it("lists exactly the three sign-in sliver specs, one per line", () => {
    const text = readFileSync(sliverList, "utf8");
    const entries = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(entries).toHaveLength(3);
    expect([...listedSpecs(text)].sort()).toEqual([...SLIVER].sort());
  });

  it("names specs that exist in tests/e2e", () => {
    for (const name of listedSpecs(readFileSync(sliverList, "utf8"))) {
      const path = fileURLToPath(new URL(`../tests/e2e/${name}`, import.meta.url));
      expect(() => readFileSync(path), name).not.toThrow();
    }
  });
});

describe("scripts/test-frontend.sh engine selection (#1614)", () => {
  const specArgs = (args) => args.filter((arg) => arg.endsWith(".spec.ts")).map((arg) => basename(arg));

  it("ORBIT_E2E_ENGINES=webkit hands Playwright exactly the three sliver specs", async () => {
    const result = await runScript([], script, { env: { ORBIT_E2E_ENGINES: "webkit" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.args, "the Playwright stub was never started").not.toBeNull();
    expect(result.args[0]).toBe("test:e2e");
    expect([...specArgs(result.args)].sort()).toEqual([...SLIVER].sort());
    expect(result.env.ORBIT_E2E_ENGINES).toBe("webkit");
  });

  it("ORBIT_E2E_ENGINES=firefox exits 0 without starting Playwright and says the rig runs Firefox", async () => {
    const result = await runScript([], script, { env: { ORBIT_E2E_ENGINES: "firefox" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.env, "Playwright was started for firefox").toBeNull();
    expect(result.stdout).toMatch(/rig/i);
    expect(result.stdout).toMatch(/firefox/i);
  });

  it("ORBIT_E2E_ENGINES=firefox needs no running service: it exits before the health check", async () => {
    const result = await runScript([], script, { env: { ORBIT_E2E_ENGINES: "firefox" }, curlExit: 7 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.env, "Playwright was started for firefox").toBeNull();
  });

  it("ORBIT_E2E_ENGINES=chromium runs the whole suite: no spec is named", async () => {
    const result = await runScript([], script, { env: { ORBIT_E2E_ENGINES: "chromium" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.args, "the Playwright stub was never started").not.toBeNull();
    expect(result.args).toEqual(["test:e2e"]);
    expect(result.env.ORBIT_E2E_ENGINES).toBe("chromium");
  });

  it("with ORBIT_E2E_ENGINES unset runs the whole suite: no spec is named", async () => {
    const result = await runScript([]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.args, "the Playwright stub was never started").not.toBeNull();
    expect(result.args).toEqual(["test:e2e"]);
  });
});
