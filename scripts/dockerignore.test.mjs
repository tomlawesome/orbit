import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dockerignorePath = join(process.cwd(), ".dockerignore");

function entries() {
  return readFileSync(dockerignorePath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

// #383: backup.sh / restore.sh / export-recovery-bundle.sh / orbit backup all
// default to writing into <repo>/backups (scripts/backup.sh:8,
// scripts/restore.sh:8, src/cli/orbit.ts's resolveBackupRestorePaths), which
// is exactly the build context `bash scripts/build-container.sh` uses. A
// missing entry here lets a local source build copy plaintext PostgreSQL
// dumps -- and, if a restore was interrupted, the raw document KEK -- into
// intermediate builder-stage image layers.
describe(".dockerignore", () => {
  it("excludes the local backups directory alongside the other secret-bearing generated paths", () => {
    const lines = entries();
    expect(lines).toContain("backups");
    expect(lines).toContain(".orbit-secrets");
    expect(lines).toContain(".env-orbit");
  });
});
