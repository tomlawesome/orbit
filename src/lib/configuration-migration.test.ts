import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  classifyMigrationResult,
  installMigrateCommand,
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

// #1316 O1-S1 (owner decision 2026-10-11, option a): a .env-orbit that is not
// valid UTF-8 is refused, never rewritten. Decoding it as UTF-8 silently turns
// the stray byte into U+FFFD (EF BF BD) and corrupts the operator's value.
describe("migration of an .env-orbit that is not valid UTF-8 (#1316 O1-S1)", () => {
  // Legacy file, valid except for one lone 0xE9 (Latin-1 e-acute) in a password.
  function latin1Deployment(): { dir: string; original: Buffer } {
    const original = Buffer.concat([
      Buffer.from(`ORBIT_IMAGE=${IMAGE}\nSMTP_PASSWORD=caf`, "utf8"),
      Buffer.from([0xe9]),
      Buffer.from("-secret\n", "utf8"),
    ]);
    const dir = mkdtempSync(join(tmpdir(), "orbit-migration-utf8-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env-orbit"), original, { mode: 0o600 });
    return { dir, original };
  }

  it("fails the install-transaction migration with a message naming UTF-8 and leaves the file's bytes unchanged", () => {
    const { dir, original } = latin1Deployment();
    const result = installMigrateCommand(targetFor(dir));
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toMatch(/^Orbit configuration: migrated/);
    const outcome = runConfigurationMigration(targetFor(dir));
    expect(outcome.ok).toBe(false);
    expect(`${result.stderr}\n${result.stdout}\n${outcome.message}`).toMatch(/utf-?8/i);
    const after = readFileSync(join(dir, ".env-orbit"));
    expect(after.equals(original)).toBe(true);
    expect(after.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it("leaves no rollback or scratch file beside the refused file", () => {
    const { dir } = latin1Deployment();
    expect(runConfigurationMigration(targetFor(dir)).ok).toBe(false);
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
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
