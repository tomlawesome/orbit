import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "configuration.sh");
const appliedVersion = "v1.2.0";
const appliedDigest = `sha256:${"a".repeat(64)}`;
const appliedImage = `registry.example/orbit@${appliedDigest}`;
const appliedProject = "orbit-test";

function migrationArgs() {
  return [
    "--migrate",
    "--orbit-image",
    appliedImage,
    "--applied-version",
    appliedVersion,
    "--applied-digest",
    appliedDigest,
    "--compose-project-name",
    appliedProject,
  ];
}

function run(content, args = ["--check"], options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "orbit-configuration-test-"));
  const file = join(directory, ".env-orbit");
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  const result = spawnSync("bash", [script, ...args, "--file", file], {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  return { ...result, file };
}

describe("configuration.sh", () => {
  it("accepts legacy data without rewriting operator values", () => {
    const original = "APP_URL=https://orbit.example.invalid\r\nPOSTGRES_DB=spaces and = signs==\r\n";
    const result = run(original, migrationArgs());
    expect(result.status).toBe(0);
    expect(readFileSync(result.file, "utf8")).toContain("APP_URL=https://orbit.example.invalid\r\nPOSTGRES_DB=spaces and = signs==\r\n");
    expect(readFileSync(result.file, "utf8")).toContain("ORBIT_CONFIG_SCHEMA_VERSION=1\r\n");
    expect(readFileSync(result.file, "utf8")).toContain(`ORBIT_IMAGE=${appliedImage}\r\n`);
    expect(readFileSync(result.file, "utf8")).toContain(`ORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}\r\n`);
    expect(readFileSync(result.file, "utf8")).toContain(`ORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}\r\n`);
    expect(readFileSync(result.file, "utf8")).toContain(`COMPOSE_PROJECT_NAME=${appliedProject}\r\n`);
    expect(result.stdout).toContain(`schema v0 version legacy/unknown digest legacy/unknown to schema v1 version ${appliedVersion} digest ${appliedDigest}`);
    expect(result.stdout).not.toMatch(/orbit\.example|spaces/iu);
  });

  it("keeps preflight non-mutating and makes migrate the only marker mutation", () => {
    const original = "# keep\nAPP_URL=https://orbit.example.invalid\nPOSTGRES_DB=orbit\n";
    const preflight = run(original, ["--preflight"]);
    expect(preflight.status).toBe(0);
    expect(readFileSync(preflight.file, "utf8")).toBe(original);
    expect(existsSync(`${preflight.file}.orbit-config.rollback`)).toBe(false);

    const migrated = run(original, migrationArgs());
    expect(migrated.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toContain(original);
    expect(readFileSync(migrated.file, "utf8")).toContain(`ORBIT_IMAGE=${appliedImage}\n`);
    expect(lstatSync(`${migrated.file}.orbit-config.rollback`).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${migrated.file}.orbit-config.rollback`, "utf8")).toBe(original);

    const rerun = spawnSync("bash", [script, ...migrationArgs(), "--file", migrated.file], { encoding: "utf8" });
    expect(rerun.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toContain(`ORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}\n`);
    expect(rerun.stdout).toContain(`already current schema v1 version ${appliedVersion} digest ${appliedDigest}`);
    expect(existsSync(`${migrated.file}.orbit-config.rollback`)).toBe(true);
  });

  it("supports installer-transaction migration without an adjacent rollback", () => {
    const original = "APP_URL=https://orbit.example.invalid\nPOSTGRES_DB=orbit";
    const migrated = run(original, [...migrationArgs(), "--transaction"]);
    expect(migrated.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toContain(original);
    expect(readFileSync(migrated.file, "utf8")).toContain(`ORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}\n`);
    expect(existsSync(`${migrated.file}.orbit-config.rollback`)).toBe(false);
  });

  it("preserves comments, CRLF, internal spaces, equals, and no-final-newline", () => {
    const original = "  # retained\r\nPOSTGRES_DB=internal spaces and = signs==";
    const migrated = run(original, migrationArgs());
    expect(migrated.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toContain(original);
    expect(readFileSync(migrated.file, "utf8")).toContain(`ORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}\r\n`);
  });

  it("reports an already-current configuration without rewriting it or creating rollback", () => {
    const original = [
      `ORBIT_IMAGE=${appliedImage}`,
      "ORBIT_CONFIG_SCHEMA_VERSION=1",
      `ORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}`,
      `ORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}`,
      `COMPOSE_PROJECT_NAME=${appliedProject}`,
      "APP_URL=https://orbit.example.invalid",
      "POSTGRES_DB=orbit",
      "",
    ].join("\n");
    const result = run(original, migrationArgs());
    expect(result.status).toBe(0);
    expect(readFileSync(result.file, "utf8")).toBe(original);
    expect(result.stdout.trim()).toBe(
      `Orbit configuration: already current schema v1 version ${appliedVersion} digest ${appliedDigest}`,
    );
    expect(existsSync(`${result.file}.orbit-config.rollback`)).toBe(false);
  });

  it("rejects malformed, partial, and mismatched provenance metadata without disclosure", () => {
    for (const content of [
      `ORBIT_IMAGE=${appliedImage}\nORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}\nAPP_URL=https://orbit.example.invalid\n`,
      `ORBIT_IMAGE=${appliedImage}\nORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}\nAPP_URL=https://orbit.example.invalid\n`,
      `ORBIT_IMAGE=${appliedImage}\nORBIT_CONFIG_APPLIED_VERSION=not-semver\nORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}\nAPP_URL=https://orbit.example.invalid\n`,
      `ORBIT_IMAGE=${appliedImage}\nORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}\nORBIT_CONFIG_APPLIED_DIGEST=sha256:${"b".repeat(64)}\nAPP_URL=https://orbit.example.invalid\n`,
    ]) {
      const result = run(content, ["--preflight"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).toBe("configuration_provenance");
      expect(`${result.stdout}${result.stderr}`).not.toContain("orbit.example.invalid");
    }
  });

  it("requires target provenance when standalone migration has no prior provenance", () => {
    const result = run("APP_URL=https://orbit.example.invalid\n");
    const migration = spawnSync("bash", [script, "--migrate", "--file", result.file], { encoding: "utf8" });
    expect(migration.status).not.toBe(0);
    expect(migration.stderr.trim()).toBe("configuration_provenance_required");
    expect(readFileSync(result.file, "utf8")).toBe("APP_URL=https://orbit.example.invalid\n");
    expect(`${migration.stdout}${migration.stderr}`).not.toContain("orbit.example.invalid");
  });

  it("classifies every documented example key without values", () => {
    const example = readFileSync(join(process.cwd(), ".env-orbit.example"), "utf8");
    const keys = new Set();
    for (const match of example.matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gmu)) keys.add(match[1]);
    const result = run([...keys].map((key) => {
      if (key === "ORBIT_CONFIG_SCHEMA_VERSION") return `${key}=1`;
      if (key === "ORBIT_IMAGE") return `${key}=${appliedImage}`;
      if (key === "ORBIT_CONFIG_APPLIED_VERSION") return `${key}=${appliedVersion}`;
      if (key === "ORBIT_CONFIG_APPLIED_DIGEST") return `${key}=${appliedDigest}`;
      if (key === "COMPOSE_PROJECT_NAME") return `${key}=${appliedProject}`;
      return `${key}=value`;
    }).join("\n") + "\n");
    expect(result.status).toBe(0);
    for (const key of keys) expect(result.stdout).toMatch(new RegExp(`^(?:current|deprecated_supported) ${key}$`, "mu"));
    expect(result.stdout).not.toContain("value");
  });

  it("rejects duplicates, unknown keys, interpolation and unsafe modes", () => {
    for (const content of [
      "APP_URL=https://a.example.invalid\nAPP_URL=https://b.example.invalid\n",
      "NOT_IN_CONTRACT=value\n",
      "APP_URL=${HOST}\n",
      "APP_URL=$HOST\n",
      "APP_URL=$(hostname)\n",
      "APP_URL=\"https://a.example.invalid\"\n",
      "APP_URL=`hostname`\n",
      "APP_URL=a\\b\n",
      "APP_URL=https://a.example.invalid#comment\n",
      "APP_URL= leading\n",
      "APP_URL=trailing \n",
      " APP_URL=https://a.example.invalid\n",
      "\n",
    ]) {
      const result = run(content);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toMatch(/https?:|HOST|value/iu);
      expect(`${result.stdout}${result.stderr}`).not.toContain("NOT_IN_CONTRACT");
    }
    const result = run("APP_URL=https://a.example.invalid\n");
    chmodSync(result.file, 0o640);
    const unsafe = spawnSync("bash", [script, "--check", "--file", result.file], { encoding: "utf8" });
    expect(unsafe.status).not.toBe(0);
  });

  it("rejects invalid or mismatched managed Compose project identity", () => {
    for (const [value, code] of [
      ["", "configuration_project"],
      ["Orbit", "configuration_project"],
      ["-orbit", "configuration_project"],
      ["orbit project", "configuration_project"],
      ["orbit$host", "configuration_syntax"],
    ]) {
      const result = run(`APP_URL=https://a.example.invalid\nCOMPOSE_PROJECT_NAME=${value}\n`);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).toBe(code);
      if (value) expect(`${result.stdout}${result.stderr}`).not.toContain(value);
    }

    const mismatch = run(
      `ORBIT_IMAGE=${appliedImage}\nORBIT_CONFIG_SCHEMA_VERSION=1\nORBIT_CONFIG_APPLIED_VERSION=${appliedVersion}\nORBIT_CONFIG_APPLIED_DIGEST=${appliedDigest}\nCOMPOSE_PROJECT_NAME=one\n`,
      [...migrationArgs().slice(0, -2), "--compose-project-name", "two"],
    );
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr.trim()).toBe("configuration_project_mismatch");
    expect(readFileSync(mismatch.file, "utf8")).toContain("COMPOSE_PROJECT_NAME=one");
    expect(`${mismatch.stdout}${mismatch.stderr}`).not.toContain("one");
  });

  it("rejects NUL/control, oversized, directory, and symlink inputs without disclosure", () => {
    const controls = run(Buffer.from("APP_URL=https://a.example.invalid\nPOSTGRES_DB=bad\x01\n"));
    expect(controls.status).not.toBe(0);
    const oversized = run(`APP_URL=${"a".repeat(4097)}\n`);
    expect(oversized.status).not.toBe(0);

    const directory = mkdtempSync(join(tmpdir(), "orbit-configuration-directory-"));
    const directoryResult = spawnSync("bash", [script, "--check", "--file", directory], { encoding: "utf8" });
    expect(directoryResult.status).not.toBe(0);

    const target = mkdtempSync(join(tmpdir(), "orbit-configuration-link-"));
    const real = join(target, "real");
    const link = join(target, "link");
    writeFileSync(real, "APP_URL=https://a.example.invalid\n");
    chmodSync(real, 0o600);
    symlinkSync(real, link);
    const linkResult = spawnSync("bash", [script, "--check", "--file", link], { encoding: "utf8" });
    expect(linkResult.status).not.toBe(0);
    expect(`${linkResult.stdout}${linkResult.stderr}`).not.toContain("a.example.invalid");
  });

  it("rolls back an interrupted atomic migration and leaves the original intact", () => {
    const original = "APP_URL=https://orbit.example.invalid\nPOSTGRES_DB=orbit\n";
    const fakeBin = mkdtempSync(join(tmpdir(), "orbit-configuration-mv-"));
    writeFileSync(join(fakeBin, "mv"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(fakeBin, "mv"), 0o755);
    const result = run(original, migrationArgs(), { env: { PATH: `${fakeBin}:${process.env.PATH}` } });
    expect(result.status).not.toBe(0);
    expect(readFileSync(result.file, "utf8")).toBe(original);
    expect(readFileSync(`${result.file}.orbit-config.rollback`, "utf8")).toBe(original);
    expect(`${result.stdout}${result.stderr}`).not.toContain("orbit.example.invalid");
  });

  it("reports future and gap schema versions with a distinct bounded code", () => {
    for (const value of ["2", "0"]) {
      const result = run(`ORBIT_CONFIG_SCHEMA_VERSION=${value}\nAPP_URL=https://a.example.invalid\n`);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).toBe("configuration_version");
    }
  });
});
