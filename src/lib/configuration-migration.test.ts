import { describe, expect, it } from "vitest";

import {
  buildMigrateArgv,
  buildPreflightArgv,
  runConfigurationMigration,
  runConfigurationPreflight,
  type ConfigurationMigrationTarget,
  type ConfigurationScriptAdapter,
} from "./configuration-migration";

// Ported from scripts/install.sh's run_configuration_migration and its
// --preflight companion call (docs/installer-guarantees.md, Part 1 /
// install.sh, guarantee #29 — cited by number in test names below). See
// docs/adr-notes/295-install-port-plan.md for the slice this belongs to,
// and configuration-migration.parity.test.ts for whole-script parity
// against the real, unmodified scripts/configuration.sh.

const TARGET: ConfigurationMigrationTarget = {
  environmentFile: ".env-orbit",
  orbitImage: "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64),
  appliedVersion: "v1.2.3",
  appliedDigest: "sha256:" + "a".repeat(64),
  composeProjectName: "orbit",
};

describe("buildPreflightArgv", () => {
  it("matches install.sh's exact invocation (install.sh:1444)", () => {
    expect(buildPreflightArgv(".env-orbit")).toEqual(["--preflight", "--file", ".env-orbit"]);
  });
});

describe("buildMigrateArgv", () => {
  it("matches install.sh's exact invocation and argument order (install.sh:1013-1018)", () => {
    expect(buildMigrateArgv(TARGET)).toEqual([
      "--migrate",
      "--transaction",
      "--file",
      ".env-orbit",
      "--orbit-image",
      TARGET.orbitImage,
      "--applied-version",
      "v1.2.3",
      "--compose-project-name",
      "orbit",
      "--applied-digest",
      TARGET.appliedDigest,
    ]);
  });
});

function adapterReturning(preflight: { status: number; stdout: string }, migrate?: { status: number; stdout: string }): ConfigurationScriptAdapter {
  return {
    runPreflight: () => preflight,
    runMigrate: () => migrate ?? preflight,
  };
}

describe("runConfigurationPreflight", () => {
  it("passes on exit 0, whether the file is current or a legacy schema needing migration", () => {
    const adapter = adapterReturning({ status: 0, stdout: "current ORBIT_IMAGE\n" });
    expect(runConfigurationPreflight("scripts/configuration.sh", ".env-orbit", adapter)).toEqual({ ok: true });
  });

  it("fails closed with install.sh's exact message on any non-zero exit", () => {
    const adapter = adapterReturning({ status: 1, stdout: "" });
    expect(runConfigurationPreflight("scripts/configuration.sh", ".env-orbit", adapter)).toEqual({
      ok: false,
      message: "Configuration preflight failed; restoring the previous deployment.",
    });
  });
});

describe("runConfigurationMigration (#29)", () => {
  it("accepts the idempotent 'already current' message", () => {
    const message = "Orbit configuration: already current schema v1 version v1.2.3 digest sha256:abc\n";
    const adapter = adapterReturning({ status: 0, stdout: "" }, { status: 0, stdout: message });
    const outcome = runConfigurationMigration("scripts/configuration.sh", TARGET, adapter);
    expect(outcome).toEqual({ ok: true, message: message.replace(/\n+$/, "") });
  });

  it("accepts the successful-migration message", () => {
    const message =
      "Orbit configuration: migrated from schema v0 version legacy/unknown digest legacy/unknown to schema v1 version v1.2.3 digest sha256:abc\n";
    const adapter = adapterReturning({ status: 0, stdout: "" }, { status: 0, stdout: message });
    const outcome = runConfigurationMigration("scripts/configuration.sh", TARGET, adapter);
    expect(outcome).toEqual({ ok: true, message: message.replace(/\n+$/, "") });
  });

  it("fails closed with install.sh's exact message on any non-zero exit", () => {
    const adapter = adapterReturning({ status: 0, stdout: "" }, { status: 1, stdout: "" });
    expect(runConfigurationMigration("scripts/configuration.sh", TARGET, adapter)).toEqual({
      ok: false,
      message: "Configuration migration failed; restoring the previous deployment.",
    });
  });

  it("treats a plausible-looking but unexpected output string as failure, not success", () => {
    const adapter = adapterReturning(
      { status: 0, stdout: "" },
      { status: 0, stdout: "Orbit configuration: something else entirely\n" },
    );
    expect(runConfigurationMigration("scripts/configuration.sh", TARGET, adapter)).toEqual({
      ok: false,
      message: "Configuration migration returned an unexpected result; restoring the previous deployment.",
    });
  });

  it("treats empty output on exit 0 as failure", () => {
    const adapter = adapterReturning({ status: 0, stdout: "" }, { status: 0, stdout: "" });
    expect(runConfigurationMigration("scripts/configuration.sh", TARGET, adapter)).toEqual({
      ok: false,
      message: "Configuration migration returned an unexpected result; restoring the previous deployment.",
    });
  });
});
