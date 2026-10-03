import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// #1151 O2-S2: backup.sh's final bundle rename used `mv --no-clobber`, whose
// own existence check is a separate stat-then-rename, not atomic, and which
// exits 0 without moving anything on a same-second timestamp collision --
// the script then printed "Orbit backup created" naming the OLD bundle,
// while the new one sat forgotten as a stale .tar.installing file (cleanup
// never runs for it, since temporary_path is cleared right after the mv).
//
// publish_bundle_atomically replaces that mv with `ln`, which fails
// atomically (EEXIST) if final_path already exists, mirroring
// publishBundleAtomically in src/lib/recovery-bundle.ts. This extracts the
// real function from backup.sh (never a hand-typed duplicate) and drives it
// against real files, so a regression back to `mv --no-clobber` fails here.

const backupScriptSource = readFileSync(join(import.meta.dirname, "backup.sh"), "utf8");

function extractFunction(source, name) {
  const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "mu");
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find function ${name}() in the given source`);
  return match[0];
}

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function makeScratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-backup-publish-race-"));
  scratchDirs.push(dir);
  return dir;
}

function runPublish(temporaryPath, finalPath) {
  const script = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `temporary_path=${JSON.stringify(temporaryPath)}`,
    `final_path=${JSON.stringify(finalPath)}`,
    'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
    extractFunction(backupScriptSource, "publish_bundle_atomically"),
    "publish_bundle_atomically",
  ].join("\n");

  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

describe("backup.sh publishes the final bundle race-free (#1151 O2-S2)", () => {
  it("publishes a fresh bundle and removes the temporary file", () => {
    const dir = makeScratchDir();
    const temporaryPath = join(dir, "orbit-20261003-000000.tar.installing");
    const finalPath = join(dir, "orbit-20261003-000000.tar");
    writeFileSync(temporaryPath, "new-bundle-bytes");

    const result = runPublish(temporaryPath, finalPath);

    expect(result.status).toBe(0);
    expect(readFileSync(finalPath, "utf8")).toBe("new-bundle-bytes");
    expect(() => readFileSync(temporaryPath, "utf8")).toThrow();
  });

  it("refuses rather than silently reporting success when a bundle already exists at the final path", () => {
    const dir = makeScratchDir();
    const temporaryPath = join(dir, "orbit-20261003-000000.tar.installing");
    const finalPath = join(dir, "orbit-20261003-000000.tar");
    writeFileSync(finalPath, "old-bundle-bytes");
    writeFileSync(temporaryPath, "new-bundle-bytes");

    const result = runPublish(temporaryPath, finalPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("A backup already exists at");
    // Neither bundle is lost or silently clobbered: the old one is
    // untouched, and the new one is still on disk under its temporary name
    // for the caller's own cleanup trap to remove -- never left as a
    // forgotten .tar.installing the way a successful `mv --no-clobber`
    // no-op used to leave it.
    expect(readFileSync(finalPath, "utf8")).toBe("old-bundle-bytes");
    expect(readFileSync(temporaryPath, "utf8")).toBe("new-bundle-bytes");
  });
});
