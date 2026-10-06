import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readGolden } from "./__fixtures__/golden";
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
    ensureSecretFile(dir, ".orbit-secrets/session-secret", false);
    return true;
  } catch {
    return false;
  }
}

// --- layer 5: scripts/configure.sh ----------------------------------------
//
// Since #1210 configure.sh runs layer 4 (the engine) in a container, so there
// is no fifth implementation left to drift. What the retired bash did with
// each candidate was captured before it was deleted
// (src/lib/__fixtures__/session-secret-configure); the engine is held to it.

interface CapturedBash {
  value: string;
  valid: boolean;
  status: number;
  stderr: string;
}

function capturedBash(label: string): CapturedBash {
  return readGolden<CapturedBash>("session-secret-configure", label);
}

/** The engine's own refusal message for a session-secret value, or "" when it accepts it. */
function engineRefusal(value: string): string {
  const dir = scratchDir("orbit-session-secret-engine-message-");
  mkdirSync(join(dir, ".orbit-secrets"));
  chmodSync(join(dir, ".orbit-secrets"), 0o700);
  writeFileSync(join(dir, ".orbit-secrets", "session-secret"), `${value}\n`, { mode: 0o600 });
  try {
    ensureSecretFile(dir, ".orbit-secrets/session-secret", false);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

  it.each(CANDIDATES)("the retired bash configure.sh agreed about $label (captured)", ({ label, value, valid }) => {
    const bash = capturedBash(label);
    expect(bash.value).toBe(value);
    expect(bash.status === 0).toBe(valid);
    expect(engineAccepts(value)).toBe(bash.status === 0);
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

    const refusal = engineRefusal("z".repeat(64));
    expect(refusal).toContain("openssl rand -hex 32");
    expect(refusal).toContain("active sessions stay signed in");
  });

  it("the engine words that refusal exactly as the retired bash did", () => {
    const bash = capturedBash("64 non-hexadecimal characters");
    expect(bash.stderr.trim()).toBe(`Orbit configuration: ${secretFileFormatMessage(".orbit-secrets/session-secret")}`);
    expect(engineRefusal("z".repeat(64))).toBe(secretFileFormatMessage(".orbit-secrets/session-secret"));
  });

  it("only the session secret carries the sign-out warning", () => {
    expect(secretFileFormatMessage(".orbit-secrets/document-kek")).not.toContain("signs out");
    expect(secretFileFormatMessage(".orbit-secrets/postgres-password")).not.toContain("signs out");
  });
});
