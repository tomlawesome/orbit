import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * #1604 D-F1-2: under `set -e` the script's own setup commands (the header
 * file's mktemp, mkdir of .orbit-supply-chain) end it with the tool's raw
 * message. Every other failure prints "carry-previous-release: FAILED: <cause>"
 * and exits 1; a setup failure must too.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./carry-previous-release.sh", import.meta.url).pathname;
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function prepare({ tmpdirValue, blockSupplyChain = false }) {
  const work = mkdtempSync(join(tmpdir(), "carry-setup-"));
  dirs.push(work);
  if (blockSupplyChain) writeFileSync(join(work, ".orbit-supply-chain"), "a file, not a folder");
  // A curl that must never be reached: setup fails first.
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), "#!/usr/bin/env bash\nexit 97\n");
  chmodSync(join(bin, "curl"), 0o755);
  return failOnProcessDeadline(
    spawnSync("bash", [script, "--prepare"], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: tmpdirValue ?? tmpdir(),
        CI_API_V4_URL: "https://gitlab.example.test/api/v4",
        CI_PROJECT_ID: "42",
        CI_COMMIT_REF_NAME: "dev",
        CI_JOB_ID: "9001",
        CI_JOB_TOKEN: "glcbt-TEST-TOKEN-NOT-REAL",
      },
      ...processGuard(),
    }),
    { label: "carry --prepare" },
  );
}

describe("carry-previous-release.sh --prepare setup failures (#1604 D-F1-2)", () => {
  it("names the cause in the script's own FAILED line when the header file cannot be made", () => {
    const result = prepare({ tmpdirValue: "/nonexistent-carry-tmp/dir" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("carry-previous-release: FAILED:");
  });

  it("names the cause in the script's own FAILED line when .orbit-supply-chain cannot be made", () => {
    const result = prepare({ blockSupplyChain: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("carry-previous-release: FAILED:");
    expect(result.stderr).toContain(".orbit-supply-chain");
  });
});
