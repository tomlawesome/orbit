import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * The web fidelity gates run from web/, so they reach the quarantine list
 * check (scripts/check-quarantine.mjs, exit 1 when an @quarantine tag is not
 * on tests/quarantine.txt) as `node ../scripts/check-quarantine.mjs ..`. It
 * must come first and be joined with `&&`, so a failing check stops the run
 * before Playwright starts. The `:quarantine` runs only report, so they need
 * not run it.
 */
const { scripts } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../web/package.json", import.meta.url)), "utf8"),
);

describe("web fidelity scripts run the quarantine list check first", () => {
  for (const name of ["fidelity", "fidelity:webkit"]) {
    it(`${name} starts with the check, joined with &&`, () => {
      expect(scripts[name]).toMatch(/^node \.\.\/scripts\/check-quarantine\.mjs \.\. && /);
    });
  }
});

/*
 * Behaviour, not just shape: run the script string itself with bash in a
 * scratch web/ whose `playwright` only records its calls and whose
 * ../scripts/check-quarantine.mjs is a stub with a chosen exit code. A failing
 * check must stop every Playwright run the script would start.
 */
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runScript(name, checkExit) {
  const root = mkdtempSync(join(tmpdir(), "web-fidelity-"));
  dirs.push(root);
  const web = join(root, "web");
  const bin = join(root, "bin");
  const calls = join(root, "playwright-calls.log");
  mkdirSync(web);
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "check-quarantine.mjs"), `process.exit(${checkExit});\n`);
  writeFileSync(calls, "");
  writeFileSync(join(bin, "playwright"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 0\n`);
  chmodSync(join(bin, "playwright"), 0o755);
  const r = spawnSync("bash", ["-c", scripts[name]], {
    cwd: web,
    encoding: "utf8",
    timeout: PROCESS_DEADLINE_MS,
    killSignal: "SIGKILL",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME },
  });
  const calledWith = readFileSync(calls, "utf8").split("\n").filter((l) => l !== "");
  return { status: r.status, error: r.error, calledWith };
}

describe("web fidelity scripts stop when the quarantine check fails", () => {
  for (const name of ["fidelity", "fidelity:webkit"]) {
    it(`${name} runs no Playwright and exits non-zero when the check fails`, () => {
      const r = runScript(name, 1);
      expect(r.error).toBeUndefined();
      expect(r.calledWith).toEqual([]);
      expect(r.status).not.toBe(0);
    });
  }

  it("fidelity runs both Playwright projects when the check passes", () => {
    const r = runScript("fidelity", 0);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.calledWith).toHaveLength(2);
    expect(r.calledWith[0]).toContain("--project=fidelity");
    expect(r.calledWith[1]).toContain("--project=pocket-measure");
  });

  it("fidelity:webkit runs its Playwright project when the check passes", () => {
    const r = runScript("fidelity:webkit", 0);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.calledWith).toHaveLength(1);
    expect(r.calledWith[0]).toContain("--project=pocket-webkit");
  });
});
