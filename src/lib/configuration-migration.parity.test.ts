import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
import {
  CONFIGURATION_ROLLBACK_SUFFIX,
  installMigrateCommand,
  installPreflightCommand,
  runConfigurationCommand,
  runConfigurationMigration,
  runConfigurationPreflight,
  type ConfigurationMigrationTarget,
} from "./configuration-migration";

// The configuration contract port (#1210 D8) against what the retired
// scripts/configuration.sh produced for the same inputs, captured from
// b0ee5929 (src/lib/__fixtures__/README.md). Every case compares exit
// status, stdout, the stderr code, and the file, rollback copy and deploy
// lock left behind. Golden-file characterization: the fixtures are bash's,
// never regenerated from this port.

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-configuration-parity-"));
  sandboxes.push(dir);
  return dir;
}

interface MatrixCase {
  name: string;
  input: {
    content: string;
    args: string[];
    mode?: number;
    rollback?: string;
    lock?: string;
    lockAgeMinutes?: number;
    symlink?: boolean;
    directory?: boolean;
    missing?: boolean;
    noFile?: boolean;
  };
  bash: {
    status: number;
    stdout: string;
    stderr: string;
    file: string | null;
    fileMode: number | null;
    rollback: { content: string; mode: number } | null;
    lock: string | null;
    migratingLeftovers: number;
  };
}

const matrix = readGolden<{ cases: MatrixCase[] }>("configuration-migration", "matrix");

describe("configuration contract port: every captured configuration.sh case", () => {
  it("has the full captured matrix", () => {
    expect(matrix.cases.length).toBe(94);
  });

  for (const testCase of matrix.cases) {
    it(testCase.name, () => {
      const { input, bash } = testCase;
      const dir = sandbox();
      const file = join(dir, ".env-orbit");
      writeFileSync(file, input.content);
      chmodSync(file, input.mode ?? 0o600);
      const rollbackPath = `${file}${CONFIGURATION_ROLLBACK_SUFFIX}`;
      if (input.rollback !== undefined) {
        writeFileSync(rollbackPath, input.rollback);
        chmodSync(rollbackPath, 0o600);
      }
      const lockPath = join(dir, ".orbit-engine.lock");
      if (input.lock !== undefined) {
        writeFileSync(lockPath, input.lock);
        if (input.lockAgeMinutes) {
          const stale = new Date(Date.now() - input.lockAgeMinutes * 60_000);
          utimesSync(lockPath, stale, stale);
        }
      }
      let argFile = file;
      if (input.symlink) {
        argFile = join(dir, "link");
        symlinkSync(file, argFile);
      }
      if (input.directory) argFile = dir;
      if (input.missing) argFile = join(dir, "absent");
      const args = input.noFile ? input.args : [...input.args, "--file", argFile];

      const result = runConfigurationCommand(args, join(dir, ".env-orbit"));

      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: bash.status,
        stdout: bash.stdout,
        stderr: bash.stderr,
      });
      expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(bash.file);
      expect(existsSync(file) ? lstatSync(file).mode & 0o777 : null).toBe(bash.fileMode);
      expect(
        existsSync(rollbackPath)
          ? { content: readFileSync(rollbackPath, "utf8"), mode: lstatSync(rollbackPath).mode & 0o777 }
          : null,
      ).toEqual(bash.rollback);
      expect(existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null).toBe(bash.lock);
      expect(readdirSync(dir).filter((name) => name.includes("migrating")).length).toBe(bash.migratingLeftovers);
    });
  }
});

// install's hand-off (runConfigurationPreflight / runConfigurationMigration,
// install.sh:1405-1424 and 2040), called in-process as the install engine
// does since #1212, against the bash results the old reference adapter
// recorded.

const IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "b".repeat(64);
const DIGEST = "sha256:" + "b".repeat(64);

function targetFor(dir: string, overrides: Partial<ConfigurationMigrationTarget> = {}): ConfigurationMigrationTarget {
  return {
    environmentFile: join(dir, ".env-orbit"),
    orbitImage: IMAGE,
    appliedVersion: "v1.0.0",
    appliedDigest: DIGEST,
    composeProjectName: "orbit",
    ...overrides,
  };
}

interface HandOffStep {
  kind: "preflight" | "migrate";
  status: number;
  stdout: string;
  file: string;
}

function handOffSandbox(content: string): string {
  const dir = sandbox();
  writeFileSync(join(dir, ".env-orbit"), content, { mode: 0o600 });
  chmodSync(join(dir, ".env-orbit"), 0o600);
  return dir;
}

function expectSteps(dir: string, golden: HandOffStep[], steps: Array<() => { status: number; stdout: string }>): void {
  expect(steps.length).toBe(golden.length);
  steps.forEach((step, index) => {
    const result = step();
    expect({ kind: golden[index].kind, status: result.status, stdout: result.stdout }).toEqual({
      kind: golden[index].kind,
      status: golden[index].status,
      stdout: golden[index].stdout,
    });
    expect(readFileSync(join(dir, ".env-orbit"), "utf8")).toBe(golden[index].file);
  });
}

describe("install's preflight / migrate --transaction hand-off", () => {
  it("agrees: an already-current file reports already current and preflight passes", () => {
    const golden = readGolden<HandOffStep[]>(
      "configuration-migration-parity",
      "agrees: an already-current file reports already current and preflight passes",
    );
    const dir = handOffSandbox(
      [`ORBIT_IMAGE=${IMAGE}`, "ORBIT_CONFIG_SCHEMA_VERSION=1", "ORBIT_CONFIG_APPLIED_VERSION=v1.0.0", `ORBIT_CONFIG_APPLIED_DIGEST=${DIGEST}`, "COMPOSE_PROJECT_NAME=orbit", ""].join("\n"),
    );
    expectSteps(dir, golden, [
      () => installPreflightCommand(join(dir, ".env-orbit")),
      () => installMigrateCommand(targetFor(dir)),
    ]);
    expect(runConfigurationPreflight(join(dir, ".env-orbit"))).toEqual({ ok: true });
    const migration = runConfigurationMigration(targetFor(dir));
    expect(migration.ok).toBe(true);
    expect(migration.message).toContain("already current schema v1 version v1.0.0");
  });

  it("agrees: a legacy unversioned file migrates and preflight still passes (configuration.sh #25)", () => {
    const golden = readGolden<HandOffStep[]>(
      "configuration-migration-parity",
      "agrees: a legacy unversioned file migrates and preflight still passes (#configuration.sh #25 — schema-2 outcome)",
    );
    const dir = handOffSandbox(`ORBIT_IMAGE=${IMAGE}\n`);
    expectSteps(dir, golden, [
      () => installPreflightCommand(join(dir, ".env-orbit")),
      () => installMigrateCommand(targetFor(dir)),
    ]);
  });

  it("agrees: a structurally invalid file fails preflight closed (install.sh:1444-1445)", () => {
    const golden = readGolden<HandOffStep[]>(
      "configuration-migration-parity",
      "agrees: a structurally invalid file fails preflight closed (install.sh:1444-1445)",
    );
    const dir = handOffSandbox("this is not a valid assignment line\n");
    expectSteps(dir, golden, [() => installPreflightCommand(join(dir, ".env-orbit"))]);
    expect(runConfigurationPreflight(join(dir, ".env-orbit"))).toEqual({
      ok: false,
      message: "Configuration preflight failed; restoring the previous deployment.",
    });
  });

  it("agrees: a compose project mismatch fails the migration closed (configuration.sh #17)", () => {
    const golden = readGolden<HandOffStep[]>(
      "configuration-migration-parity",
      "agrees: a compose project mismatch fails the migration closed (configuration.sh #17)",
    );
    const dir = handOffSandbox([`ORBIT_IMAGE=${IMAGE}`, "ORBIT_CONFIG_SCHEMA_VERSION=1", "COMPOSE_PROJECT_NAME=some-other-project", ""].join("\n"));
    expectSteps(dir, golden, [() => installMigrateCommand(targetFor(dir, { composeProjectName: "orbit" }))]);
    expect(runConfigurationMigration(targetFor(dir, { composeProjectName: "orbit" }))).toEqual({
      ok: false,
      message: "Configuration migration failed; restoring the previous deployment.",
    });
  });
});
