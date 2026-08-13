import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildMigrateArgv,
  buildPreflightArgv,
  runConfigurationMigration,
  runConfigurationPreflight,
  type ConfigurationMigrationTarget,
  type ConfigurationScriptAdapter,
} from "./configuration-migration";

// Whole-script parity between this module's decision logic and the real,
// unmodified scripts/configuration.sh --preflight / --migrate --transaction
// entry points (issue #295 slice 3). Unlike install-transaction.parity.test.ts
// and target-identity.parity.test.ts (which awk-extract function bodies
// because install.sh's transaction phase has no standalone entry point),
// configuration.sh already has real, independently-invocable --preflight
// and --migrate flags — the same situation src/lib/config-contract.
// parity.test.ts is in for `configure.sh --check`, so this test spawns the
// real script directly (stronger than function extraction: it proves the
// exact argv this module builds actually drives the live script to the
// message this module expects), through a reference adapter local to this
// file (not shipped — see configuration-migration.ts's module comment for
// why a real subprocess adapter isn't shipped in this slice).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes: string[] = [];

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

function makeSandbox(envOrbitContent: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), "orbit-configuration-migration-parity-"));
  sandboxes.push(sandbox);
  mkdirSync(join(sandbox, "scripts"));
  cpSync(join(repoRoot, "scripts", "configuration.sh"), join(sandbox, "scripts", "configuration.sh"));
  writeFileSync(join(sandbox, ".env-orbit"), envOrbitContent, { mode: 0o600 });
  chmodSync(join(sandbox, ".env-orbit"), 0o600);
  return sandbox;
}

// Reference adapter: shells the real script exactly as install.sh does
// (bash <script> <args...>), through this module's own argv builders — not
// shipped from configuration-migration.ts itself (see that module's header
// comment for why: a "handoff", not a port, and slice 5 owns the real
// production subprocess call).
function realAdapter(sandbox: string): ConfigurationScriptAdapter {
  return {
    runPreflight: (configurationScript, environmentFile) => {
      const result = spawnSync("bash", [configurationScript, ...buildPreflightArgv(environmentFile)], {
        cwd: sandbox,
        encoding: "utf8",
      });
      return { status: result.status ?? -1, stdout: result.stdout };
    },
    runMigrate: (configurationScript, target) => {
      const result = spawnSync("bash", [configurationScript, ...buildMigrateArgv(target)], {
        cwd: sandbox,
        encoding: "utf8",
      });
      return { status: result.status ?? -1, stdout: result.stdout };
    },
  };
}

const IMAGE = "ghcr.io/tomlawesome/orbit@sha256:" + "b".repeat(64);
const DIGEST = "sha256:" + "b".repeat(64);

function targetFor(overrides: Partial<ConfigurationMigrationTarget> = {}): ConfigurationMigrationTarget {
  return {
    environmentFile: ".env-orbit",
    orbitImage: IMAGE,
    appliedVersion: "v1.0.0",
    appliedDigest: DIGEST,
    composeProjectName: "orbit",
    ...overrides,
  };
}

describe("configuration.sh --preflight / --migrate --transaction parity", () => {
  it("agrees: an already-current file reports 'already current' and preflight passes", () => {
    const sandbox = makeSandbox(
      [
        `ORBIT_IMAGE=${IMAGE}`,
        "ORBIT_CONFIG_SCHEMA_VERSION=1",
        "ORBIT_CONFIG_APPLIED_VERSION=v1.0.0",
        `ORBIT_CONFIG_APPLIED_DIGEST=${DIGEST}`,
        "COMPOSE_PROJECT_NAME=orbit",
        "",
      ].join("\n"),
    );
    const adapter = realAdapter(sandbox);
    const scriptPath = join(sandbox, "scripts", "configuration.sh");

    const preflight = runConfigurationPreflight(scriptPath, ".env-orbit", adapter);
    expect(preflight).toEqual({ ok: true });

    const migration = runConfigurationMigration(scriptPath, targetFor(), adapter);
    expect(migration.ok).toBe(true);
    expect(migration.message).toContain("already current schema v1 version v1.0.0");
  });

  it("agrees: a legacy unversioned file migrates and preflight still passes (#configuration.sh #25 — schema-2 outcome)", () => {
    const sandbox = makeSandbox([`ORBIT_IMAGE=${IMAGE}`, ""].join("\n"));
    const adapter = realAdapter(sandbox);
    const scriptPath = join(sandbox, "scripts", "configuration.sh");

    const preflight = runConfigurationPreflight(scriptPath, ".env-orbit", adapter);
    expect(preflight).toEqual({ ok: true });

    const migration = runConfigurationMigration(scriptPath, targetFor(), adapter);
    expect(migration.ok).toBe(true);
    expect(migration.message).toContain("migrated from schema v0 version legacy/unknown digest legacy/unknown");
    expect(migration.message).toContain("to schema v1 version v1.0.0");
  });

  it("agrees: a structurally invalid file fails preflight closed (install.sh:1444-1445)", () => {
    const sandbox = makeSandbox(["this is not a valid assignment line", ""].join("\n"));
    const adapter = realAdapter(sandbox);
    const scriptPath = join(sandbox, "scripts", "configuration.sh");

    const preflight = runConfigurationPreflight(scriptPath, ".env-orbit", adapter);
    expect(preflight).toEqual({
      ok: false,
      message: "Configuration preflight failed; restoring the previous deployment.",
    });
  });

  it("agrees: a compose project mismatch fails the migration closed (configuration.sh #17)", () => {
    const sandbox = makeSandbox(
      [`ORBIT_IMAGE=${IMAGE}`, "ORBIT_CONFIG_SCHEMA_VERSION=1", "COMPOSE_PROJECT_NAME=some-other-project", ""].join(
        "\n",
      ),
    );
    const adapter = realAdapter(sandbox);
    const scriptPath = join(sandbox, "scripts", "configuration.sh");

    const migration = runConfigurationMigration(scriptPath, targetFor({ composeProjectName: "orbit" }), adapter);
    expect(migration).toEqual({
      ok: false,
      message: "Configuration migration failed; restoring the previous deployment.",
    });
  });
});
