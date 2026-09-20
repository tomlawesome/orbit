import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ComposeProjectNameRefusal,
  TargetValidationRefusal,
  deriveComposeProjectName,
  isPreprovisionedInput,
  readEnvironmentValue,
  validateTarget,
} from "./target-identity";

// Ported from scripts/install.sh's is_preprovisioned_input, validate_target
// and derive_compose_project_name (docs/installer-guarantees.md, Part 1 /
// install.sh, guarantees #6, #7, #12 — cited by number in test names below).
// See docs/adr-notes/295-install-port-plan.md for the slice this belongs to
// and byte-for-byte parity coverage against the real script.

let targetDir: string;

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), "orbit-target-identity-"));
});

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true });
});

function seedPreprovisioned(): void {
  writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
  const secretsDir = join(targetDir, ".orbit-secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  writeFileSync(join(secretsDir, "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
}

describe("isPreprovisionedInput (guarantee #6)", () => {
  it("accepts the exact contract: 600 env file, 700 secrets dir, only non-empty 600 files, nothing else", () => {
    seedPreprovisioned();
    expect(isPreprovisionedInput(targetDir)).toBe(true);
  });

  it("accepts multiple secret files as long as every one is non-empty, regular and 600", () => {
    seedPreprovisioned();
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "hunter2", { mode: 0o600 });
    expect(isPreprovisionedInput(targetDir)).toBe(true);
  });

  it("refuses when .env-orbit is missing", () => {
    const secretsDir = join(targetDir, ".orbit-secrets");
    mkdirSync(secretsDir, { mode: 0o700 });
    writeFileSync(join(secretsDir, "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses a symlinked .env-orbit", () => {
    seedPreprovisioned();
    rmSync(join(targetDir, ".env-orbit"));
    writeFileSync(join(targetDir, "real-env"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    symlinkSync(join(targetDir, "real-env"), join(targetDir, ".env-orbit"));
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses a loosely permissioned .env-orbit", () => {
    seedPreprovisioned();
    // writeFileSync's mode option only applies when a file is *created*; the
    // file already exists from seedPreprovisioned, so chmod it explicitly.
    chmodSync(join(targetDir, ".env-orbit"), 0o644);
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when .orbit-secrets is mode 755, not 700", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    const secretsDir = join(targetDir, ".orbit-secrets");
    mkdirSync(secretsDir, { mode: 0o755 });
    writeFileSync(join(secretsDir, "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when an extraneous entry exists in the target directory", () => {
    seedPreprovisioned();
    writeFileSync(join(targetDir, "docker-compose.yml"), "services: {}\n");
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when a secret file is empty", () => {
    seedPreprovisioned();
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "", { mode: 0o600 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when a secret file is loosely permissioned", () => {
    seedPreprovisioned();
    writeFileSync(join(targetDir, ".orbit-secrets", "postgres-password"), "hunter2", { mode: 0o640 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when a secret \"file\" is actually a directory", () => {
    seedPreprovisioned();
    mkdirSync(join(targetDir, ".orbit-secrets", "nested"), { mode: 0o700 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when the oidc-client-secret file is missing", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    const secretsDir = join(targetDir, ".orbit-secrets");
    mkdirSync(secretsDir, { mode: 0o700 });
    writeFileSync(join(secretsDir, "postgres-password"), "hunter2", { mode: 0o600 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });

  it("refuses when the oidc-client-secret file is empty", () => {
    seedPreprovisioned();
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "", { mode: 0o600 });
    expect(isPreprovisionedInput(targetDir)).toBe(false);
  });
});

describe("validateTarget (guarantee #7)", () => {
  it("treats a genuinely empty target as target_was_empty", () => {
    expect(validateTarget(targetDir)).toEqual({ targetWasEmpty: true });
  });

  it("recognizes an existing deployment: regular .env-orbit + docker-compose.yml + real .orbit-secrets", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    writeFileSync(join(targetDir, "docker-compose.yml"), "services: {}\n");
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    expect(validateTarget(targetDir)).toEqual({ targetWasEmpty: false });
  });

  it("recognizes safe pre-provisioned input as target_was_empty=true even though the directory is not empty", () => {
    seedPreprovisioned();
    expect(validateTarget(targetDir)).toEqual({ targetWasEmpty: true });
  });

  it("refuses an arbitrary non-empty directory that is neither shape", () => {
    writeFileSync(join(targetDir, "README.md"), "hello\n");
    expect(() => validateTarget(targetDir)).toThrow(TargetValidationRefusal);
  });

  it("refuses when docker-compose.yml is a symlink, even with the other two files correct", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    writeFileSync(join(targetDir, "real-compose.yml"), "services: {}\n");
    symlinkSync(join(targetDir, "real-compose.yml"), join(targetDir, "docker-compose.yml"));
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    expect(() => validateTarget(targetDir)).toThrow(TargetValidationRefusal);
  });

  it("refuses when .orbit-secrets is a symlink, even with the other two files correct", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n", { mode: 0o600 });
    writeFileSync(join(targetDir, "docker-compose.yml"), "services: {}\n");
    mkdirSync(join(targetDir, "real-secrets"), { mode: 0o700 });
    symlinkSync(join(targetDir, "real-secrets"), join(targetDir, ".orbit-secrets"));
    expect(() => validateTarget(targetDir)).toThrow(TargetValidationRefusal);
  });
});

describe("readEnvironmentValue (install.sh's own line-scanner, used by derive_compose_project_name)", () => {
  it("returns undefined when .env-orbit does not exist", () => {
    expect(readEnvironmentValue(targetDir, "COMPOSE_PROJECT_NAME")).toBeUndefined();
  });

  it("returns undefined when the key is not assigned", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://example.invalid\n");
    expect(readEnvironmentValue(targetDir, "COMPOSE_PROJECT_NAME")).toBeUndefined();
  });

  it("returns the last assignment when a key is duplicated, exactly like the bash while-read loop", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=first\nCOMPOSE_PROJECT_NAME=second\n");
    expect(readEnvironmentValue(targetDir, "COMPOSE_PROJECT_NAME")).toBe("second");
  });
});

describe("deriveComposeProjectName (guarantee #12)", () => {
  it("derives a sanitized name from the fallback basename when nothing else is configured", () => {
    const result = deriveComposeProjectName(targetDir, undefined, "My Orbit Deployment!");
    expect(result).toEqual({ composeProjectName: "my-orbit-deployment-", explicit: false, provisional: true });
  });

  it("strips leading dashes and underscores produced by sanitizing the fallback basename", () => {
    const result = deriveComposeProjectName(targetDir, undefined, "--_Orbit");
    expect(result.composeProjectName).toBe("orbit");
  });

  it("refuses when the sanitized fallback basename is empty or still invalid", () => {
    expect(() => deriveComposeProjectName(targetDir, undefined, "---___")).toThrow(ComposeProjectNameRefusal);
  });

  it("uses the configured .env-orbit value when present and valid", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=configured-project\n", { mode: 0o600 });
    const result = deriveComposeProjectName(targetDir, undefined, "fallback");
    expect(result).toEqual({ composeProjectName: "configured-project", explicit: true, provisional: false });
  });

  it("refuses an invalid configured .env-orbit project name", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=Not_Valid!\n", { mode: 0o600 });
    expect(() => deriveComposeProjectName(targetDir, undefined, "fallback")).toThrow(ComposeProjectNameRefusal);
  });

  it("ignores a configured value in a symlinked .env-orbit (only a real, regular file is trusted)", () => {
    writeFileSync(join(targetDir, "real-env"), "COMPOSE_PROJECT_NAME=configured-project\n");
    symlinkSync(join(targetDir, "real-env"), join(targetDir, ".env-orbit"));
    const result = deriveComposeProjectName(targetDir, undefined, "fallback-name");
    expect(result).toEqual({ composeProjectName: "fallback-name", explicit: false, provisional: true });
  });

  it("prefers an explicit requested name over the fallback when no file is configured", () => {
    const result = deriveComposeProjectName(targetDir, "requested-project", "fallback");
    expect(result).toEqual({ composeProjectName: "requested-project", explicit: true, provisional: false });
  });

  it("refuses an invalid requested project name", () => {
    expect(() => deriveComposeProjectName(targetDir, "Not_Valid!", "fallback")).toThrow(ComposeProjectNameRefusal);
  });

  it("accepts a requested name that matches the already-configured file value", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=same-project\n", { mode: 0o600 });
    const result = deriveComposeProjectName(targetDir, "same-project", "fallback");
    expect(result).toEqual({ composeProjectName: "same-project", explicit: true, provisional: false });
  });

  it("refuses when the requested name conflicts with the configured file value", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=configured-project\n", { mode: 0o600 });
    expect(() => deriveComposeProjectName(targetDir, "other-project", "fallback")).toThrow(ComposeProjectNameRefusal);
  });

  it("treats an empty requested name the same as unset (bash's -n test)", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=configured-project\n", { mode: 0o600 });
    const result = deriveComposeProjectName(targetDir, "", "fallback");
    expect(result).toEqual({ composeProjectName: "configured-project", explicit: true, provisional: false });
  });

  // #999/#1043: docker-compose.yml:1 declares `name: orbit` and nothing read
  // it, so a fresh install into ~/apps/household named the Compose project
  // "household". The declaration now outranks the basename and is not
  // provisional, so no caller derives again over the top of it.
  it("reads the target docker-compose.yml's own name: in preference to the fallback basename", () => {
    writeFileSync(join(targetDir, "docker-compose.yml"), "name: orbit\n\nservices: {}\n");
    const result = deriveComposeProjectName(targetDir, undefined, "household");
    expect(result).toEqual({ composeProjectName: "orbit", explicit: false, provisional: false });
  });

  it("marks the fallback basename provisional when no compose file is in the target yet", () => {
    const result = deriveComposeProjectName(targetDir, undefined, "household");
    expect(result).toEqual({ composeProjectName: "household", explicit: false, provisional: true });
  });

  it("keeps the configured .env-orbit value above the compose file's name:", () => {
    writeFileSync(join(targetDir, ".env-orbit"), "COMPOSE_PROJECT_NAME=configured-project\n", { mode: 0o600 });
    writeFileSync(join(targetDir, "docker-compose.yml"), "name: orbit\n");
    expect(deriveComposeProjectName(targetDir, undefined, "household")).toEqual({
      composeProjectName: "configured-project",
      explicit: true,
      provisional: false,
    });
  });

  it("keeps an explicitly requested name above the compose file's name:", () => {
    writeFileSync(join(targetDir, "docker-compose.yml"), "name: orbit\n");
    expect(deriveComposeProjectName(targetDir, "requested-project", "household")).toEqual({
      composeProjectName: "requested-project",
      explicit: true,
      provisional: false,
    });
  });

  it("falls through to the basename for a name: Compose itself would not accept, rather than refusing", () => {
    writeFileSync(join(targetDir, "docker-compose.yml"), "name: Not_Valid!\n");
    expect(deriveComposeProjectName(targetDir, undefined, "household")).toEqual({
      composeProjectName: "household",
      explicit: false,
      provisional: true,
    });
  });

  it("ignores a name: in a symlinked docker-compose.yml (only a real, regular file is trusted)", () => {
    writeFileSync(join(targetDir, "real-compose.yml"), "name: orbit\n");
    symlinkSync(join(targetDir, "real-compose.yml"), join(targetDir, "docker-compose.yml"));
    expect(deriveComposeProjectName(targetDir, undefined, "household")).toEqual({
      composeProjectName: "household",
      explicit: false,
      provisional: true,
    });
  });

  it("ignores a service-level or indented name key, reading only the top-level one", () => {
    writeFileSync(join(targetDir, "docker-compose.yml"), "services:\n  orbit-app:\n    name: sneaky\n");
    expect(deriveComposeProjectName(targetDir, undefined, "household")).toEqual({
      composeProjectName: "household",
      explicit: false,
      provisional: true,
    });
  });

  it("strips an inline comment and surrounding quotes from the declared name, as the bash does", () => {
    writeFileSync(join(targetDir, "docker-compose.yml"), 'name: "orbit"   # the project every script addresses\n');
    expect(deriveComposeProjectName(targetDir, undefined, "household")).toEqual({
      composeProjectName: "orbit",
      explicit: false,
      provisional: false,
    });
  });
});
