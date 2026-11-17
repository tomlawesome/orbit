import { appendFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIGURATION_ROLLBACK_SUFFIX, migrateEnvironmentFile, type MigrateEnvironmentFileOptions } from "./configuration-migration";

// #1877: roll-forward recovery after the commit point. A leftover
// `<file>.orbit-config.rollback` that is the pre-migration file of a migration
// that got past its rename is proven by replaying that migration on the copy;
// it is then removed instead of refusing (migrate path) or being kept
// (already-current path).

const IMAGE_A = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
const IMAGE_B = "ghcr.io/tomlawesome/orbit@sha256:" + "b".repeat(64);
const LEGACY = `ORBIT_IMAGE=${IMAGE_A}\n# operator comment\nSMTP_HOST=mail.example\n`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const targetA = (): MigrateEnvironmentFileOptions => ({
  orbitImage: IMAGE_A,
  appliedVersion: "v1.2.3",
  appliedDigest: "sha256:" + "a".repeat(64),
  composeProjectName: "orbit",
});
const targetB = (): MigrateEnvironmentFileOptions => ({
  orbitImage: IMAGE_B,
  appliedVersion: "v1.3.0",
  appliedDigest: "sha256:" + "b".repeat(64),
  composeProjectName: "orbit",
});

const envFile = (dir: string) => join(dir, ".env-orbit");
const copyOf = (dir: string) => `${envFile(dir)}${CONFIGURATION_ROLLBACK_SUFFIX}`;

/** The state a run killed just after its rename leaves: the completed file, and the pre-migration bytes as the copy. */
function killedAfterRename(): { dir: string; migrated: string } {
  const dir = mkdtempSync(join(tmpdir(), "orbit-migration-replay-"));
  dirs.push(dir);
  writeFileSync(envFile(dir), LEGACY, { mode: 0o600 });
  expect(migrateEnvironmentFile(envFile(dir), targetA()).status).toBe(0);
  const migrated = readFileSync(envFile(dir), "utf8");
  writeFileSync(copyOf(dir), LEGACY, { mode: 0o600 });
  return { dir, migrated };
}

const ALREADY_CURRENT_STDOUT = `Orbit configuration: already current schema v1 version v1.2.3 digest sha256:${"a".repeat(64)}\n`;

describe("a leftover rollback copy from a migration that finished (#1877)", () => {
  it("the operator migrates to the next release and it succeeds, with the old copy gone", () => {
    const { dir } = killedAfterRename();
    const result = migrateEnvironmentFile(envFile(dir), targetB());
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Orbit configuration: migrated from schema v1 version v1\.2\.3 /);
    expect(readFileSync(envFile(dir), "utf8")).toContain("ORBIT_CONFIG_APPLIED_VERSION=v1.3.0\n");
    expect(existsSync(copyOf(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
  });

  it("the operator re-runs the same target: already current, the copy is removed and nothing says it was kept", () => {
    const { dir, migrated } = killedAfterRename();
    const result = migrateEnvironmentFile(envFile(dir), targetA());
    expect(result).toEqual({ status: 0, stdout: ALREADY_CURRENT_STDOUT, stderr: "" });
    expect(existsSync(copyOf(dir))).toBe(false);
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
  });

  it("the operator edited the file after the kill: migrating to the next release still refuses, changing neither file", () => {
    const { dir, migrated } = killedAfterRename();
    appendFileSync(envFile(dir), "# edited after the kill\n");
    const edited = migrated + "# edited after the kill\n";
    const result = migrateEnvironmentFile(envFile(dir), targetB());
    expect(result).toEqual({ status: 1, stdout: "", stderr: "configuration_migration\n" });
    expect(readFileSync(copyOf(dir), "utf8")).toBe(LEGACY);
    expect(readFileSync(envFile(dir), "utf8")).toBe(edited);
  });

  it("the operator edited the file after the kill: re-running the same target keeps the copy and names it", () => {
    const { dir } = killedAfterRename();
    appendFileSync(envFile(dir), "# edited after the kill\n");
    const result = migrateEnvironmentFile(envFile(dir), targetA());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ALREADY_CURRENT_STDOUT);
    const lines = result.stderr.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(copyOf(dir));
    expect(lines[0]).toMatch(/repair/iu);
    expect(readFileSync(copyOf(dir), "utf8")).toBe(LEGACY);
    expect(lstatSync(copyOf(dir)).mode & 0o777).toBe(0o600);
  });

  it("a copy that does not parse: migrating to the next release refuses and leaves it", () => {
    const { dir, migrated } = killedAfterRename();
    writeFileSync(copyOf(dir), "not an assignment\n", { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), targetB());
    expect(result).toEqual({ status: 1, stdout: "", stderr: "configuration_migration\n" });
    expect(readFileSync(copyOf(dir), "utf8")).toBe("not an assignment\n");
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
  });

  it("a copy that does not parse: re-running the same target keeps it and names it", () => {
    const { dir, migrated } = killedAfterRename();
    writeFileSync(copyOf(dir), "not an assignment\n", { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), targetA());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ALREADY_CURRENT_STDOUT);
    expect(result.stderr).toContain(copyOf(dir));
    expect(readFileSync(copyOf(dir), "utf8")).toBe("not an assignment\n");
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
  });

  for (const [label, target, expected] of [
    ["migrating to the next release", targetB, { status: 1, stdout: "", stderr: "configuration_migration\n" }],
    ["re-running the same target", targetA, { status: 1, stdout: "", stderr: "configuration_migration\n" }],
  ] as const) {
    it(`a copy that is a symlink: ${label} refuses, and the link, its target and the file are untouched`, () => {
      const { dir, migrated } = killedAfterRename();
      rmSync(copyOf(dir));
      const outside = mkdtempSync(join(tmpdir(), "orbit-migration-outside-"));
      dirs.push(outside);
      const linkTarget = join(outside, "elsewhere");
      writeFileSync(linkTarget, LEGACY, { mode: 0o600 });
      symlinkSync(linkTarget, copyOf(dir));
      const result = migrateEnvironmentFile(envFile(dir), target());
      expect(result).toEqual(expected);
      expect(lstatSync(copyOf(dir)).isSymbolicLink()).toBe(true);
      expect(readFileSync(linkTarget, "utf8")).toBe(LEGACY);
      expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
    });
  }
});
