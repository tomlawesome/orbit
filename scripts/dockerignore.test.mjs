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

  // #449: web/ became a workspace member with its own node_modules (108 MB)
  // and generated build/preview/test outputs. A bare `node_modules` entry only
  // matches the root directory, so all of it flowed into the build context
  // and into builder-stage layers. The image must build web/ from source, so
  // its generated outputs must never leak in from the host either.
  it("excludes nested node_modules and the web build outputs from the context", () => {
    const lines = entries();
    expect(lines).toContain("**/node_modules");
    expect(lines).toContain("web/build");
    expect(lines).toContain("web/.svelte-kit");
    expect(lines).toContain("web/.preview");
    expect(lines).toContain("web/test-results");
  });
});
