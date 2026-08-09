import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "configuration.sh");

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
  it("accepts legacy data and migrates only by adding the marker", () => {
    const original = "APP_URL=https://orbit.example.invalid\r\nPOSTGRES_DB=spaces and = signs==\r\n";
    const result = run(original, ["--migrate"]);
    expect(result.status).toBe(0);
    expect(readFileSync(result.file, "utf8")).toMatch(/^APP_URL=.*\r\nPOSTGRES_DB=.*\r\nORBIT_CONFIG_SCHEMA_VERSION=1\r\n$/u);
    expect(result.stdout).not.toMatch(/orbit\.example|spaces/iu);
  });

  it("keeps preflight non-mutating and makes migrate the only marker mutation", () => {
    const original = "# keep\nAPP_URL=https://orbit.example.invalid\nPOSTGRES_DB=orbit\n";
    const preflight = run(original, ["--preflight"]);
    expect(preflight.status).toBe(0);
    expect(readFileSync(preflight.file, "utf8")).toBe(original);
    expect(existsSync(`${preflight.file}.orbit-config.rollback`)).toBe(false);

    const migrated = run(original, ["--migrate"]);
    expect(migrated.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toBe(`${original}ORBIT_CONFIG_SCHEMA_VERSION=1\n`);
    expect(lstatSync(`${migrated.file}.orbit-config.rollback`).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${migrated.file}.orbit-config.rollback`, "utf8")).toBe(original);

    const rerun = spawnSync("bash", [script, "--migrate", "--file", migrated.file], { encoding: "utf8" });
    expect(rerun.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toBe(`${original}ORBIT_CONFIG_SCHEMA_VERSION=1\n`);
  });

  it("supports installer-transaction migration without an adjacent rollback", () => {
    const original = "APP_URL=https://orbit.example.invalid\nPOSTGRES_DB=orbit";
    const migrated = run(original, ["--migrate", "--transaction"]);
    expect(migrated.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toBe(`${original}\nORBIT_CONFIG_SCHEMA_VERSION=1\n`);
    expect(existsSync(`${migrated.file}.orbit-config.rollback`)).toBe(false);
  });

  it("preserves comments, CRLF, internal spaces, equals, and no-final-newline", () => {
    const original = "  # retained\r\nPOSTGRES_DB=internal spaces and = signs==";
    const migrated = run(original, ["--migrate"]);
    expect(migrated.status).toBe(0);
    expect(readFileSync(migrated.file, "utf8")).toBe(`${original}\r\nORBIT_CONFIG_SCHEMA_VERSION=1\r\n`);
  });

  it("classifies every documented example key without values", () => {
    const example = readFileSync(join(process.cwd(), ".env-orbit.example"), "utf8");
    const keys = new Set();
    for (const match of example.matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gmu)) keys.add(match[1]);
    const result = run([...keys].map((key) => `${key}=${key === "ORBIT_CONFIG_SCHEMA_VERSION" ? "1" : "value"}`).join("\n") + "\n");
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
    const result = run(original, ["--migrate"], { env: { PATH: `${fakeBin}:${process.env.PATH}` } });
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
