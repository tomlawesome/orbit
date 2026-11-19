import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONFIGURATION_ROLLBACK_SUFFIX,
  classifyMigrationResult,
  installMigrateCommand,
  migrateEnvironmentFile,
  type MigrateEnvironmentFileOptions,
  runConfigurationMigration,
  runConfigurationPreflight,
  type ConfigurationMigrationTarget,
} from "./configuration-migration";
import { parseEnvOrbitContent } from "./env-orbit-file";

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

// #1643: COMPOSE_FILE and COMPOSE_PATH_SEPARATOR are Compose's own settings,
// passed through like COMPOSE_PROFILES: the update must not refuse them and
// must keep their lines unchanged.
describe("migration of an .env-orbit holding COMPOSE_FILE and COMPOSE_PATH_SEPARATOR (#1643)", () => {
  const composeLines = ["COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml", "COMPOSE_PATH_SEPARATOR=:"];

  it("passes the preflight", () => {
    const dir = deployment(`ORBIT_IMAGE=${IMAGE}\n${composeLines.join("\n")}\n`);
    expect(runConfigurationPreflight(join(dir, ".env-orbit"))).toEqual({ ok: true });
  });

  it("keeps both lines byte for byte in the written file", () => {
    const dir = deployment(`ORBIT_IMAGE=${IMAGE}\n${composeLines.join("\n")}\n`);
    const outcome = runConfigurationMigration(targetFor(dir));
    expect(outcome.ok).toBe(true);
    const written = readFileSync(join(dir, ".env-orbit"), "utf8").split("\n");
    for (const line of composeLines) expect(written).toContain(line);
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
    // The message alone: it is what the installer shows the operator, and
    // stdout is not. It must say what is wrong and which file.
    expect(outcome.message).toMatch(/utf-?8/i);
    expect(outcome.message).toContain(".env-orbit");
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
      "Orbit configuration: migrated from schema v0 version none digest none to schema v1 version v1.2.3 digest sha256:abc\n";
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

// #1834 slice 2: outside an install transaction the migration copies the
// pre-migration file to `.env-orbit.orbit-config.rollback`. Once the new file
// is confirmed good (strict re-parse, and the run's applied version, digest
// and Compose project), all under the deploy lock, the copy is removed. If
// any check fails the copy is kept, the live file is restored from it, and
// the run fails with configuration_migration. No `docker compose config`
// check: the engine runs in `docker run --network none` with no Docker
// inside (issue note 59075).
describe("standalone migration drops its rollback copy once the new file is confirmed (#1834)", () => {
  const LEGACY = `ORBIT_IMAGE=${IMAGE}\n# operator comment\nSMTP_HOST=mail.example\n`;
  const DIGEST = "sha256:" + "a".repeat(64);
  const MIGRATED_STDOUT = `Orbit configuration: migrated from schema v0 version none digest none to schema v1 version v1.2.3 digest ${DIGEST}\n`;

  function standalone(dir: string, extra: Partial<MigrateEnvironmentFileOptions> = {}): MigrateEnvironmentFileOptions {
    return {
      orbitImage: IMAGE,
      appliedVersion: "v1.2.3",
      appliedDigest: DIGEST,
      composeProjectName: "orbit",
      ...extra,
    };
  }

  const envFile = (dir: string) => join(dir, ".env-orbit");
  const copyOf = (dir: string) => `${envFile(dir)}${CONFIGURATION_ROLLBACK_SUFFIX}`;

  it("removes the rollback copy after a confirmed migration, with stdout unchanged", () => {
    const dir = deployment(LEGACY);
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual({ status: 0, stdout: MIGRATED_STDOUT, stderr: "" });
    expect(readFileSync(envFile(dir), "utf8")).toContain("COMPOSE_PROJECT_NAME=orbit\n");
    expect(existsSync(copyOf(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
  });

  function expectRestoredAndCopyKept(dir: string, result: { status: number; stdout: string; stderr: string }): void {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("configuration_migration\n");
    expect(result.stdout).not.toMatch(/^Orbit configuration: migrated/);
    expect(existsSync(copyOf(dir))).toBe(true);
    expect(readFileSync(copyOf(dir), "utf8")).toBe(LEGACY);
    expect(lstatSync(copyOf(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile(dir), "utf8")).toBe(LEGACY);
    expect(lstatSync(envFile(dir)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.includes("migrating"))).toEqual([]);
    expect(existsSync(join(dir, ".orbit-engine.lock"))).toBe(false);
  }

  // The rename seam lands the scratch file and then spoils it, standing in for
  // a write that did not produce what the migration meant to produce.
  const spoilAfterRename = (spoil: (file: string) => void) => (from: string, to: string) => {
    renameSync(from, to);
    spoil(to);
  };

  it("keeps the copy and restores the live file when the new file fails the strict re-parse", () => {
    const dir = deployment(LEGACY);
    const result = migrateEnvironmentFile(
      envFile(dir),
      standalone(dir, { rename: spoilAfterRename((file) => appendFileSync(file, "not an assignment\n")) }),
    );
    expectRestoredAndCopyKept(dir, result);
  });

  it("keeps the copy and restores the live file when the new file holds a direct secret beside its _FILE twin", () => {
    const dir = deployment(LEGACY);
    const result = migrateEnvironmentFile(
      envFile(dir),
      standalone(dir, {
        rename: spoilAfterRename((file) => appendFileSync(file, "SMTP_PASSWORD=direct\nSMTP_PASSWORD_FILE=/run/secrets/smtp\n")),
      }),
    );
    expectRestoredAndCopyKept(dir, result);
  });

  it.each([
    ["ORBIT_CONFIG_APPLIED_VERSION", "ORBIT_CONFIG_APPLIED_VERSION=v1.2.3", "ORBIT_CONFIG_APPLIED_VERSION=v9.9.9"],
    ["ORBIT_CONFIG_APPLIED_DIGEST", `ORBIT_CONFIG_APPLIED_DIGEST=${DIGEST}`, `ORBIT_CONFIG_APPLIED_DIGEST=sha256:${"b".repeat(64)}`],
    ["COMPOSE_PROJECT_NAME", "COMPOSE_PROJECT_NAME=orbit", "COMPOSE_PROJECT_NAME=another"],
  ])("keeps the copy and restores the live file when the new file's %s is not this run's value", (_key, from, to) => {
    const dir = deployment(LEGACY);
    const result = migrateEnvironmentFile(
      envFile(dir),
      standalone(dir, {
        rename: spoilAfterRename((file) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to))),
      }),
    );
    expectRestoredAndCopyKept(dir, result);
  });

  it("in transaction mode makes no copy and leaves an unrelated leftover copy untouched", () => {
    const dir = deployment(LEGACY);
    expect(migrateEnvironmentFile(envFile(dir), standalone(dir, { transaction: true })).status).toBe(0);
    expect(existsSync(copyOf(dir))).toBe(false);

    const withLeftover = deployment(LEGACY);
    writeFileSync(copyOf(withLeftover), "ORBIT_IMAGE=something-else\n", { mode: 0o600 });
    expect(migrateEnvironmentFile(envFile(withLeftover), standalone(withLeftover, { transaction: true })).status).toBe(0);
    expect(readFileSync(copyOf(withLeftover), "utf8")).toBe("ORBIT_IMAGE=something-else\n");
  });

  it("an already-current file is reported, left untouched, and gets no copy", () => {
    const dir = deployment(LEGACY);
    expect(migrateEnvironmentFile(envFile(dir), standalone(dir)).status).toBe(0);
    const migrated = readFileSync(envFile(dir), "utf8");
    rmSync(copyOf(dir), { force: true });

    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual({
      status: 0,
      stdout: `Orbit configuration: already current schema v1 version v1.2.3 digest ${DIGEST}\n`,
      stderr: "",
    });
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
  });

  it("an identical leftover from an interrupted run is replaced, and the successful run ends with no copy", () => {
    const dir = deployment(LEGACY);
    writeFileSync(copyOf(dir), LEGACY, { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual({ status: 0, stdout: MIGRATED_STDOUT, stderr: "" });
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
  });

  // #1834 slice 4: a run killed between the rename and the confirm step, or one
  // whose removal of the copy failed, leaves a current file and a copy that
  // nothing points at. The re-run with the same target is "already current".
  function currentWithLeftover(): { dir: string; migrated: string } {
    const dir = deployment(LEGACY);
    expect(migrateEnvironmentFile(envFile(dir), standalone(dir)).status).toBe(0);
    const migrated = readFileSync(envFile(dir), "utf8");
    return { dir, migrated };
  }
  const ALREADY_CURRENT = {
    status: 0,
    stdout: `Orbit configuration: already current schema v1 version v1.2.3 digest ${DIGEST}\n`,
    stderr: "",
  };

  it("already current with a leftover copy (mode 600) byte-identical to a file that passes the strict parse: the copy is removed, the file untouched", () => {
    const { dir, migrated } = currentWithLeftover();
    writeFileSync(copyOf(dir), migrated, { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual(ALREADY_CURRENT);
    expect(existsSync(copyOf(dir))).toBe(false);
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
    expect(readdirSync(dir)).toEqual([".env-orbit"]);
  });

  // #1877: the pre-migration file a killed run leaves is proven (by replaying the migration) to come from a finished migration, so it is removed with no note.
  it("already current with a leftover copy that is the pre-migration file a killed run leaves (#1877): removed, no note, the file untouched", () => {
    const { dir, migrated } = currentWithLeftover();
    writeFileSync(copyOf(dir), LEGACY, { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual(ALREADY_CURRENT);
    expect(existsSync(copyOf(dir))).toBe(false);
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
  });

  // Review of a7aa25e5: a copy that differs and is not proven by replay (#1877) is kept and named.
  it(`already current with a leftover copy that differs (some other content, not proven by the #1877 replay): kept, one stderr line names it and the next step, still "already current" with exit 0`, () => {
    const content = "ORBIT_IMAGE=something-else\n";
    const { dir, migrated } = currentWithLeftover();
    writeFileSync(copyOf(dir), content, { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(ALREADY_CURRENT.stdout);
    const lines = result.stderr.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(copyOf(dir));
    expect(lines[0]).toMatch(/remove/iu);
    expect(lines[0]).toMatch(/working/iu);
    expect(lines[0]).toMatch(/repair/iu);
    expect(readFileSync(copyOf(dir), "utf8")).toBe(content);
    expect(lstatSync(copyOf(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
  });

  it("already current with a leftover copy that is a symlink: refused, the link, its target and the file untouched", () => {
    const { dir, migrated } = currentWithLeftover();
    const outside = mkdtempSync(join(tmpdir(), "orbit-migration-outside-"));
    dirs.push(outside);
    const linkTarget = join(outside, "elsewhere");
    // Byte-identical to the live file, so only the symlink rule can refuse it.
    writeFileSync(linkTarget, migrated, { mode: 0o600 });
    symlinkSync(linkTarget, copyOf(dir));
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual({ status: 1, stdout: "", stderr: "configuration_migration\n" });
    expect(lstatSync(copyOf(dir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkTarget, "utf8")).toBe(migrated);
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
  });

  it("already current with a leftover copy that is not mode 600: refused, the copy and the file untouched", () => {
    const { dir, migrated } = currentWithLeftover();
    // Byte-identical to the live file, so only the mode rule can refuse it.
    writeFileSync(copyOf(dir), migrated, { mode: 0o644 });
    chmodSync(copyOf(dir), 0o644);
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual({ status: 1, stdout: "", stderr: "configuration_migration\n" });
    expect(readFileSync(copyOf(dir), "utf8")).toBe(migrated);
    expect(lstatSync(copyOf(dir)).mode & 0o777).toBe(0o644);
    expect(readFileSync(envFile(dir), "utf8")).toBe(migrated);
  });

  it("a leftover copy that differs from the file still refuses, changing neither file", () => {
    const dir = deployment(LEGACY);
    writeFileSync(copyOf(dir), "ORBIT_IMAGE=something-else\n", { mode: 0o600 });
    const result = migrateEnvironmentFile(envFile(dir), standalone(dir));
    expect(result).toEqual({ status: 1, stdout: "", stderr: "configuration_migration\n" });
    expect(readFileSync(envFile(dir), "utf8")).toBe(LEGACY);
    expect(readFileSync(copyOf(dir), "utf8")).toBe("ORBIT_IMAGE=something-else\n");
  });
});

// A managed key is written once, at its first matching line (#1847): the empty
// `# KEY=` placeholder after, before, or without a live line collapses, and the
// result passes the strict parse the migration applies to its input.
describe("migration writes each managed key once (#1847)", () => {
  const DIGEST = "sha256:" + "a".repeat(64);
  const TAIL = `ORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_CONFIG_APPLIED_VERSION=v1.2.3\nORBIT_CONFIG_APPLIED_DIGEST=${DIGEST}\nCOMPOSE_PROJECT_NAME=orbit\n`;
  const LIVE = `ORBIT_IMAGE=${IMAGE}\n`;

  const cases: Array<[string, string, string]> = [
    ["placeholder after the live line", "ORBIT_IMAGE=\n# ORBIT_IMAGE=\nAPP_URL=x\n", `${LIVE}APP_URL=x\n${TAIL}`],
    ["placeholder before the live line", "# ORBIT_IMAGE=\nAPP_URL=x\nORBIT_IMAGE=\n", `${LIVE}APP_URL=x\n${TAIL}`],
    ["two placeholders and no live line", "APP_URL=x\n# ORBIT_IMAGE=\n# ORBIT_IMAGE=\n", `APP_URL=x\n${LIVE}${TAIL}`],
    [
      "a commented line that carries a value",
      "ORBIT_IMAGE=\n# ORBIT_IMAGE=registry.example/x\nAPP_URL=x\n",
      `${LIVE}# ORBIT_IMAGE=registry.example/x\nAPP_URL=x\n${TAIL}`,
    ],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name}: one line per managed key, the rest byte for byte, and the file parses`, () => {
      const dir = deployment(input);
      const file = join(dir, ".env-orbit");
      const result = migrateEnvironmentFile(file, {
        orbitImage: IMAGE,
        appliedVersion: "v1.2.3",
        appliedDigest: DIGEST,
        composeProjectName: "orbit",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const output = readFileSync(file, "utf8");
      expect(output).toBe(expected);
      expect(output.split("\n").filter((line) => line.startsWith("ORBIT_IMAGE=")).length).toBe(1);
      expect(parseEnvOrbitContent(output).ok).toBe(true);
      expect(existsSync(`${file}${CONFIGURATION_ROLLBACK_SUFFIX}`)).toBe(false);
    });
  }
});
