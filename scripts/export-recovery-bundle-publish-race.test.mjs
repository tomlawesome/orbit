import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// #1151 SEC-O1: export-recovery-bundle.sh's final bundle rename used
// `mv --no-clobber`, whose own existence check is a separate
// stat-then-rename, not atomic, and which exits 0 without moving anything on
// a same-second timestamp collision -- the script then printed "Orbit
// recovery bundle created" naming the OLD bundle, while the new one sat
// forgotten as a stale .tar.installing file (cleanup never runs for it,
// since temporary_path is cleared right after the mv). backup.sh had the
// same fault and was fixed first (#1151 O2-S2,
// scripts/backup-publish-race.test.mjs).
//
// publish_bundle_atomically replaces that mv with `ln`, which fails
// atomically (EEXIST) if final_path already exists. The whole script needs a
// running Compose stack and a verified backup, so this extracts the real
// function from export-recovery-bundle.sh (never a hand-typed duplicate) and
// drives it against real files, as the backup.sh test does, so a regression
// back to `mv --no-clobber` fails here.

const exportScriptSource = readFileSync(join(import.meta.dirname, "export-recovery-bundle.sh"), "utf8");

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
  const dir = mkdtempSync(join(tmpdir(), "orbit-recovery-publish-race-"));
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
    extractFunction(exportScriptSource, "publish_bundle_atomically"),
    "publish_bundle_atomically",
  ].join("\n");

  return spawnSync("bash", ["-c", script], { encoding: "utf8" });
}

describe("export-recovery-bundle.sh publishes the final bundle race-free (#1151 SEC-O1)", () => {
  it("publishes a fresh recovery bundle and removes the temporary file", () => {
    const dir = makeScratchDir();
    const temporaryPath = join(dir, "orbit-recovery-20261004-000000.tar.installing");
    const finalPath = join(dir, "orbit-recovery-20261004-000000.tar");
    writeFileSync(temporaryPath, "new-recovery-bytes");

    const result = runPublish(temporaryPath, finalPath);

    expect(result.status).toBe(0);
    expect(readFileSync(finalPath, "utf8")).toBe("new-recovery-bytes");
    expect(() => readFileSync(temporaryPath, "utf8")).toThrow();
  });

  it("refuses rather than silently reporting success when a recovery bundle already exists at the final path", () => {
    const dir = makeScratchDir();
    const temporaryPath = join(dir, "orbit-recovery-20261004-000000.tar.installing");
    const finalPath = join(dir, "orbit-recovery-20261004-000000.tar");
    writeFileSync(finalPath, "old-recovery-bytes");
    writeFileSync(temporaryPath, "new-recovery-bytes");

    const result = runPublish(temporaryPath, finalPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`A recovery bundle already exists at ${finalPath}`);
    // Neither bundle is lost or silently clobbered: the old one is
    // untouched, and the new one is still on disk under its temporary name
    // for the script's own cleanup trap to remove -- never left as a
    // forgotten .tar.installing the way a successful `mv --no-clobber`
    // no-op used to leave it.
    expect(readFileSync(finalPath, "utf8")).toBe("old-recovery-bytes");
    expect(readFileSync(temporaryPath, "utf8")).toBe("new-recovery-bytes");
  });
});
