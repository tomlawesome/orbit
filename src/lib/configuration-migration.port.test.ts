import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { migrateEnvironmentFile } from "./configuration-migration";

// The behaviours of the configuration contract port (#1210 D8) that the
// golden matrix (configuration-migration.parity.test.ts) cannot show by
// itself: a failed final rename, a signal mid-migration, the operator
// owning what is written, and the CLI's own argument handling.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(repoRoot, "src", "cli", "orbit.ts");

const DIGEST = `sha256:${"a".repeat(64)}`;
const TARGET = {
  orbitImage: `registry.example/orbit@${DIGEST}`,
  appliedVersion: "v1.2.0",
  appliedDigest: DIGEST,
  composeProjectName: "orbit-test",
};
const LEGACY = "APP_URL=https://orbit.example.invalid\nPOSTGRES_DB=orbit\n";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orbit-configuration-port-"));
  file = join(dir, ".env-orbit");
  writeFileSync(file, LEGACY);
  chmodSync(file, 0o600);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrateEnvironmentFile", () => {
  it("restores the original from the rollback copy when the final rename fails, leaving no scratch file (configuration.sh #20)", () => {
    const result = migrateEnvironmentFile(file, {
      ...TARGET,
      rename: () => {
        throw new Error("simulated rename failure");
      },
    });
    expect(result).toEqual({ status: 1, stdout: "", stderr: "configuration_migration\n" });
    expect(readFileSync(file, "utf8")).toBe(LEGACY);
    expect(readFileSync(`${file}.orbit-config.rollback`, "utf8")).toBe(LEGACY);
    expect(readdirSync(dir).filter((name) => name.includes("migrating"))).toEqual([]);
    expect(existsSync(join(dir, ".orbit-engine.lock"))).toBe(false);
  });

  it("refuses rather than leave files it cannot hand to the host operator (#1258)", () => {
    if (process.getuid?.() === 0) return; // root can chown anywhere
    const saved = { uid: process.env.ORBIT_HOST_UID, gid: process.env.ORBIT_HOST_GID };
    process.env.ORBIT_HOST_UID = String((process.getuid?.() ?? 0) + 1);
    process.env.ORBIT_HOST_GID = "0";
    try {
      const result = migrateEnvironmentFile(file, TARGET);
      expect(result.status).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(LEGACY);
      expect(readdirSync(dir).filter((name) => name.includes("migrating"))).toEqual([]);
      expect(existsSync(`${file}.orbit-config.rollback`)).toBe(false);
    } finally {
      for (const [key, value] of [["ORBIT_HOST_UID", saved.uid], ["ORBIT_HOST_GID", saved.gid]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("a signal during a migration (#1151 O1-R4)", () => {
  it("leaves no scratch file and no lock behind, and exits with the signal's status", () => {
    // The migration is synchronous, so a SIGTERM that arrives mid-way is
    // handled as soon as it yields: the scratch file is already gone by then.
    // Without the handler Node's default would kill the process mid-write.
    const script = join(dir, "signal.ts");
    writeFileSync(
      script,
      [
        `import { migrateEnvironmentFile } from ${JSON.stringify(join(repoRoot, "src", "lib", "configuration-migration.ts"))};`,
        `migrateEnvironmentFile(${JSON.stringify(file)}, { ...${JSON.stringify(TARGET)}, rename: () => { process.kill(process.pid, "SIGTERM"); throw new Error("interrupted"); } });`,
        "setTimeout(() => process.exit(0), 5000);",
      ].join("\n"),
    );
    const result = failOnProcessDeadline(spawnSync("node", [tsx, script], { encoding: "utf8", ...processGuard() }), { label: "signal" });
    expect(result.status).toBe(143);
    expect(readdirSync(dir).filter((name) => name.includes("migrating"))).toEqual([]);
    expect(existsSync(join(dir, ".orbit-engine.lock"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(LEGACY);
  });
});

describe("orbit configure --preflight / --migrate", () => {
  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, "configure", ...args, "--dir", dir], { encoding: "utf8", ...processGuard() }), {
      label: "orbit configure",
    });
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it("migrates with install.sh's exact argument order and prints the one success line", () => {
    const result = run([
      "--migrate",
      "--transaction",
      "--file",
      file,
      "--orbit-image",
      TARGET.orbitImage,
      "--applied-version",
      TARGET.appliedVersion,
      "--compose-project-name",
      TARGET.composeProjectName,
      "--applied-digest",
      TARGET.appliedDigest,
    ]);
    expect(result).toEqual({
      status: 0,
      stdout: `Orbit configuration: migrated from schema v0 version legacy/unknown digest legacy/unknown to schema v1 version v1.2.0 digest ${DIGEST}\n`,
      stderr: "",
    });
    expect(existsSync(`${file}.orbit-config.rollback`)).toBe(false);
  });

  it("preflights <dir>/.env-orbit when no --file is given", () => {
    const result = run(["--preflight"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("safely_migratable ORBIT_CONFIG_SCHEMA_VERSION\n");
  });

  it("is a usage error (exit 2) for an option missing its value", () => {
    expect(run(["--migrate", "--orbit-image"])).toEqual({ status: 2, stdout: "", stderr: "configuration_usage\n" });
  });
});
