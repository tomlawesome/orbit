import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function runScript(args, scriptPath = script) {
  const dir = mkdtempSync(join(tmpdir(), "test-frontend-"));
  fixtures.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const envLog = join(dir, "playwright-env.txt");
  // Records the stub's whole environment, one NAME=value per line (NUL
  // separated, so a value with a newline cannot forge a line).
  const stub = `#!/usr/bin/env bash\nenv -0 > "$ENV_LOG"\nexit 0\n`;
  for (const name of ["pnpm", "curl"]) {
    writeFileSync(join(bin, name), name === "pnpm" ? stub : "#!/usr/bin/env bash\nexit 0\n");
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
        PLAYWRIGHT_BASE_URL: "http://127.0.0.1:1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", () => {});
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
      resolve({ status, stderr, env: recorded });
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
