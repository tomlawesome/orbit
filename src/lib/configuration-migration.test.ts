import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyMigrationResult,
  runConfigurationMigration,
  runConfigurationPreflight,
  type ConfigurationMigrationTarget,
} from "./configuration-migration";

// install's hand-off to the configuration migration: run_configuration_migration
// and its --preflight companion (docs/installer-guarantees.md, Part 1 /
// install.sh, guarantee #29 — cited by number in test names below). Since
// #1212 the install engine calls the port in-process; the bash results are
// still compared in configuration-migration.parity.test.ts.

const IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deployment(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-migration-handoff-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".env-orbit"), content, { mode: 0o600 });
  return dir;
}

function targetFor(dir: string): ConfigurationMigrationTarget {
  return {
    environmentFile: join(dir, ".env-orbit"),
    orbitImage: IMAGE,
    appliedVersion: "v1.2.3",
    appliedDigest: "sha256:" + "a".repeat(64),
    composeProjectName: "orbit",
  };
}

describe("runConfigurationPreflight", () => {
  it("passes a legacy file that only needs the migration", () => {
    const dir = deployment(`ORBIT_IMAGE=${IMAGE}\n`);
    expect(runConfigurationPreflight(join(dir, ".env-orbit"))).toEqual({ ok: true });
  });

  it("fails closed with install.sh's exact message on a file that does not parse", () => {
    const dir = deployment("not an assignment\n");
    expect(runConfigurationPreflight(join(dir, ".env-orbit"))).toEqual({
      ok: false,
      message: "Configuration preflight failed; restoring the previous deployment.",
    });
  });
});

describe("runConfigurationMigration (#29)", () => {
  it("stamps a legacy file in the install's transaction mode, leaving no rollback copy beside it", () => {
    const dir = deployment(`ORBIT_IMAGE=${IMAGE}\n`);
    const outcome = runConfigurationMigration(targetFor(dir));
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toMatch(/^Orbit configuration: migrated from schema /);
    expect(readFileSync(join(dir, ".env-orbit"), "utf8")).toContain("COMPOSE_PROJECT_NAME=orbit\n");
    expect(() => readFileSync(join(dir, ".env-orbit.orbit-config.rollback"))).toThrow();
  });

  it("fails closed when the recorded project disagrees", () => {
    const dir = deployment(`ORBIT_IMAGE=${IMAGE}\nORBIT_CONFIG_SCHEMA_VERSION=1\nCOMPOSE_PROJECT_NAME=another\n`);
    expect(runConfigurationMigration(targetFor(dir))).toEqual({
      ok: false,
      message: "Configuration migration failed; restoring the previous deployment.",
    });
  });
});

describe("classifyMigrationResult (#29)", () => {
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });

  it("accepts the idempotent 'already current' message", () => {
    const message = "Orbit configuration: already current schema v1 version v1.2.3 digest sha256:abc\n";
    expect(classifyMigrationResult(ok(message))).toEqual({ ok: true, message: message.replace(/\n+$/, "") });
  });

  it("accepts the successful-migration message", () => {
    const message =
      "Orbit configuration: migrated from schema v0 version legacy/unknown digest legacy/unknown to schema v1 version v1.2.3 digest sha256:abc\n";
    expect(classifyMigrationResult(ok(message))).toEqual({ ok: true, message: message.replace(/\n+$/, "") });
  });

  it("fails closed with install.sh's exact message on any non-zero exit", () => {
    expect(classifyMigrationResult({ status: 1, stdout: "", stderr: "configuration_migration\n" })).toEqual({
      ok: false,
      message: "Configuration migration failed; restoring the previous deployment.",
    });
  });

  it("treats a plausible-looking but unexpected output string as failure, not success", () => {
    expect(classifyMigrationResult(ok("Orbit configuration: something else entirely\n"))).toEqual({
      ok: false,
      message: "Configuration migration returned an unexpected result; restoring the previous deployment.",
    });
  });

  it("treats empty output on exit 0 as failure", () => {
    expect(classifyMigrationResult(ok(""))).toEqual({
      ok: false,
      message: "Configuration migration returned an unexpected result; restoring the previous deployment.",
    });
  });
});
