import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";
import { envOrbitSchema, isValidSessionSecret, secretFileFormatMessage } from "./config-contract";
import { ensureSecretFile } from "./configure-engine";
import { getAuthConfig } from "./env";

// One definition of a valid session secret, four implementations of it
// (issue #578). Before this test existed, `scripts/configure.sh` demanded 64
// hexadecimal characters, `envOrbitSchema` demanded 64 hex or empty, and the
// runtime loader in `env.ts` accepted any string of 32+ characters — so an
// instance could start happily on a value its own configure step refused,
// and a working install could not be reconfigured.
//
// Every layer below must now agree with `isValidSessionSecret`, which is the
// single rule. This is the drift alarm: widening or narrowing any one of them
// on its own fails here.

// This file spawns the real configure.sh under bash; a spawn that takes
// 0.7s quiet took 4.3s on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

interface Candidate {
  label: string;
  value: string;
  valid: boolean;
}

const CANDIDATES: Candidate[] = [
  { label: "64 lowercase hexadecimal characters", value: "a".repeat(64), valid: true },
  { label: "64 uppercase hexadecimal characters", value: "AB".repeat(32), valid: true },
  // The value that produced the original report: long enough for env.ts's old
  // `min(32)`, refused by configure.sh, so the instance ran for 19 hours while
  // its own configure step rejected the same directory.
  { label: "64 non-hexadecimal characters", value: "z".repeat(64), valid: false },
  { label: "a 49-character passphrase", value: "test-secret-that-is-at-least-thirty-two-characters", valid: false },
  { label: "32 hexadecimal characters (128-bit)", value: "a".repeat(32), valid: false },
  { label: "63 hexadecimal characters", value: "a".repeat(63), valid: false },
];

// --- layer 2: the runtime loader (src/lib/env.ts) ------------------------

const runtimeEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  OIDC_ISSUER: "https://auth.example/application/o/orbit/",
  OIDC_CLIENT_ID: "orbit",
  OIDC_CLIENT_SECRET: "client-secret",
};

function runtimeAccepts(value: string): boolean {
  try {
    getAuthConfig({ ...runtimeEnvironment, SESSION_SECRET: value });
    return true;
  } catch {
    return false;
  }
}

// --- layer 3: the .env-orbit field schema (config-contract.ts) -----------

function fieldSchemaAccepts(value: string): boolean {
  return envOrbitSchema.safeParse({ SESSION_SECRET: value }).success;
}

// --- layer 4: the TypeScript configure engine ---------------------------

function engineAccepts(value: string): boolean {
  const dir = scratchDir("orbit-session-secret-engine-");
  mkdirSync(join(dir, ".orbit-secrets"));
  chmodSync(join(dir, ".orbit-secrets"), 0o700);
  const secretPath = join(dir, ".orbit-secrets", "session-secret");
  writeFileSync(secretPath, `${value}\n`);
  chmodSync(secretPath, 0o600);
  try {
    ensureSecretFile(dir, ".orbit-secrets/session-secret");
    return true;
  } catch {
    return false;
  }
}

// --- layer 5: the real scripts/configure.sh -----------------------------

const FAKE_OPENSSL_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ "${1:-}" == "rand" ]]; then',
  "  printf 'a%.0s' {1..64}",
  "  printf '\\n'",
  "  exit 0",
  "fi",
  "exit 1",
  "",
].join("\n");

// ensure_vapid_keys is bash-only and always runs after ensure_secret_file; it
// would otherwise try to build a real image from a scratch directory that is
// not a git checkout. Mirrors scripts/configure.test.mjs's fake docker.
const FAKE_DOCKER_SCRIPT = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'case "${1:-}" in',
  "  image) exit 0 ;;",
  "  pull) exit 0 ;;",
  "  run)",
  "    printf 'public=fake-public-key\\nprivate=%s\\n' \"$(printf 'c%.0s' {1..64})\"",
  "    exit 0",
  "    ;;",
  "esac",
  "exit 1",
  "",
].join("\n");

function makeFakeBin(): string {
  const binDir = scratchDir("orbit-session-secret-fakebin-");
  for (const [name, script] of [
    ["openssl", FAKE_OPENSSL_SCRIPT],
    ["docker", FAKE_DOCKER_SCRIPT],
  ] as const) {
    writeFileSync(join(binDir, name), script);
    chmodSync(join(binDir, name), 0o755);
  }
  return binDir;
}

/** Runs the real, unmodified configure.sh bare flow over a pre-seeded session-secret file. */
function runBashConfigure(value: string): { status: number | null; stderr: string } {
  const dir = scratchDir("orbit-session-secret-bash-");
  mkdirSync(join(dir, "scripts"));
  // configuration.sh is deliberately not copied: run_configuration_preflight
  // returns early without it, keeping this fixture scoped to ensure_secret_file.
  for (const script of ["configure.sh", "installer-ui.sh"]) {
    writeFileSync(join(dir, "scripts", script), readFileSync(join(repoRoot, "scripts", script)));
    chmodSync(join(dir, "scripts", script), 0o755);
  }
  writeFileSync(join(dir, ".env-orbit.example"), readFileSync(join(repoRoot, ".env-orbit.example")));
  mkdirSync(join(dir, ".orbit-secrets"));
  chmodSync(join(dir, ".orbit-secrets"), 0o700);
  const secretPath = join(dir, ".orbit-secrets", "session-secret");
  writeFileSync(secretPath, `${value}\n`);
  chmodSync(secretPath, 0o600);

  const binDir = makeFakeBin();
  const result = failOnProcessDeadline(spawnSync("bash", [join(dir, "scripts", "configure.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ORBIT_IMAGE: "orbit-local:abcdef123456",
    },
    ...processGuard(),
  }), { label: "runBashConfigure" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

describe("a valid session secret has exactly one definition", () => {
  it.each(CANDIDATES)("the runtime loader agrees about $label", ({ value, valid }) => {
    expect(isValidSessionSecret(value)).toBe(valid);
    expect(runtimeAccepts(value)).toBe(valid);
  });

  it.each(CANDIDATES)("the .env-orbit field schema agrees about $label", ({ value, valid }) => {
    expect(fieldSchemaAccepts(value)).toBe(valid);
  });

  it.each(CANDIDATES)("the configure engine agrees about $label", ({ value, valid }) => {
    expect(engineAccepts(value)).toBe(valid);
  });

  it.each(CANDIDATES)("configure.sh agrees about $label", ({ value, valid }) => {
    const { status, stderr } = runBashConfigure(value);
    if (valid) {
      expect(stderr).not.toContain("does not contain a valid 256-bit hexadecimal secret");
      expect(status).toBe(0);
    } else {
      expect(status).not.toBe(0);
      expect(stderr).toContain("does not contain a valid 256-bit hexadecimal secret");
    }
  });

  it("an empty SESSION_SECRET is a blank .env-orbit field, never a runtime value", () => {
    // `.env-orbit` may carry `SESSION_SECRET=` when the deployment is
    // file-backed through SESSION_SECRET_FILE; the runtime must still refuse
    // to start on an empty secret.
    expect(fieldSchemaAccepts("")).toBe(true);
    expect(isValidSessionSecret("")).toBe(false);
    expect(runtimeAccepts("")).toBe(false);
  });

  it("tells an operator how to rotate, and what rotating costs", () => {
    let message = "";
    try {
      getAuthConfig({ ...runtimeEnvironment, SESSION_SECRET: "z".repeat(64) });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("openssl rand -hex 32");
    expect(message).toContain("active sessions stay signed in");

    const { stderr } = runBashConfigure("z".repeat(64));
    expect(stderr).toContain("openssl rand -hex 32");
    expect(stderr).toContain("active sessions stay signed in");
  });

  it("bash and TypeScript word that refusal identically", () => {
    // Bash cannot import config-contract.ts, so the wording is restated there
    // and pinned here rather than left to drift.
    const { stderr } = runBashConfigure("z".repeat(64));
    expect(stderr.trim()).toBe(
      `Orbit configuration: ${secretFileFormatMessage(".orbit-secrets/session-secret")}`,
    );
  });

  it("only the session secret carries the sign-out warning", () => {
    expect(secretFileFormatMessage(".orbit-secrets/document-kek")).not.toContain("signs out");
    expect(secretFileFormatMessage(".orbit-secrets/postgres-password")).not.toContain("signs out");
  });
});
