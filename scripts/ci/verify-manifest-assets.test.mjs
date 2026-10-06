import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * The check release-on-tag.yml runs (ADR-0031 #9, amended #1107 option 21a)
 * before uploading a file: does it match the sha256 the signed manifest
 * recorded for it.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./verify-manifest-assets.sh", import.meta.url).pathname;

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function run(args) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, ...args], { encoding: "utf8", ...processGuard() }),
    { label: "verify-manifest-assets" },
  );
}

describe("verify-manifest-assets.sh", () => {
  it("accepts a file whose sha256 matches the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-manifest-assets-"));
    const installPath = join(dir, "install.sh");
    writeFileSync(installPath, "echo hi\n");
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "install.sh": sha256("echo hi\n") } }),
    );

    const result = run([manifestPath, `install.sh=${installPath}`]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("install.sh matches the manifest");
  });

  it("refuses a file whose bytes do not match the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-manifest-assets-"));
    const installPath = join(dir, "install.sh");
    writeFileSync(installPath, "echo tampered\n");
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "install.sh": sha256("echo hi\n") } }),
    );

    const result = run([manifestPath, `install.sh=${installPath}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("install.sh");
    expect(result.stderr).toContain("the manifest says");
  });

  it("refuses a name the manifest has no checksum for", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-manifest-assets-"));
    const filePath = join(dir, "mystery.bin");
    writeFileSync(filePath, "anything");
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ files: {} }));

    const result = run([manifestPath, `mystery.bin=${filePath}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no sha256 recorded");
  });

  it("refuses a missing file rather than silently skipping it", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-manifest-assets-"));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ files: { "install.sh": sha256("x") } }));

    const result = run([manifestPath, `install.sh=${join(dir, "does-not-exist.sh")}`]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no file at");
  });

  it("checks every pair given, not just the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-manifest-assets-"));
    const goodPath = join(dir, "good.sh");
    const badPath = join(dir, "bad.sh");
    writeFileSync(goodPath, "good\n");
    writeFileSync(badPath, "bad\n");
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ files: { "good.sh": sha256("good\n"), "bad.sh": sha256("expected\n") } }),
    );

    const result = run([manifestPath, `good.sh=${goodPath}`, `bad.sh=${badPath}`]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("good.sh matches the manifest");
    expect(result.stderr).toContain("bad.sh");
  });
});
