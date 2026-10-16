import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../../scripts/process-budget.mjs";

// `orbit check [--rollback]` cases of the retired scripts/configure.test.mjs
// (`configure.sh --check` / `--check-rollback`) that the golden comparison in
// src/lib/config-contract.parity.test.ts does not already pin, ported before
// that suite was deleted (#1210 build note D10; the mapping is
// docs/adr-notes/1210-bash-test-retirement.md). Where the engine
// deliberately fails closed with a configuration_* code on a file its
// preflight refuses (bash printed a report), the port asserts that instead.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = fileURLToPath(new URL("./orbit.ts", import.meta.url));
const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

// Every test spawns the real CLI; budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const CANONICAL_SECRET_FILE = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret";
const REPORT_LINE = /^(ready|missing|optional|app-managed|not in use) [A-Za-z_]+$/;

let sandbox: string;
const elsewhere: string[] = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-cli-check-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  while (elsewhere.length > 0) rmSync(elsewhere.pop() as string, { recursive: true, force: true });
});

function check(args: string[] = []): { status: number; stdout: string; stderr: string; lines: string[] } {
  const result = failOnProcessDeadline(spawnSync("node", [tsx, cli, "check", ...args, "--dir", sandbox], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    ...processGuard(),
  }), { label: `orbit check ${args.join(" ")}` });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, lines: result.stdout.split("\n").filter(Boolean) };
}

function writeOwnerOnly(name: string, content: string): void {
  writeFileSync(join(sandbox, name), content);
  chmodSync(join(sandbox, name), 0o600);
}

function writeSecret(content: string, mode = 0o600): void {
  mkdirSync(join(sandbox, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"), content);
  chmodSync(join(sandbox, ".orbit-secrets", "oidc-client-secret"), mode);
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-cli-check-elsewhere-"));
  elsewhere.push(dir);
  return dir;
}

describe("orbit check (ported from scripts/configure.test.mjs --check)", () => {
  it("never discloses configured values, only fixed categories and names", () => {
    writeOwnerOnly(
      ".env-orbit",
      [
        "APP_URL=https://orbit.configure-test.internal",
        "ORBIT_IMAGE=orbit-local:abcdef123456",
        "ORBIT_AUTH_OIDC=true",
        "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
        "OIDC_CLIENT_ID=super-secret-client-id",
        "OIDC_CLIENT_SECRET=super-secret-client-secret-value",
        "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
        "SMTP_HOST=smtp.example.com",
        "SMTP_USER=orbit@example.com",
        "SMTP_PASSWORD=super-secret-smtp-password",
        "",
      ].join("\n"),
    );

    const result = check();

    expect(result.status).toBe(0);
    for (const value of ["super-secret", "smtp.example.com", "orbit.configure-test.internal", "auth.configure-test.internal"]) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
    for (const line of result.lines) expect(line).toMatch(REPORT_LINE);
    for (const line of [
      "ready APP_URL",
      "ready ORBIT_IMAGE",
      "ready OIDC_ISSUER",
      "ready OIDC_CLIENT_ID",
      "ready OIDC_CLIENT_SECRET",
      "ready OIDC_CALLBACK_URL",
      "ready mail",
      "app-managed imap",
      "optional processing",
      "optional ai",
      "optional push",
    ]) {
      expect(result.lines).toContain(line);
    }
  });

  it("treats the historical loopback default and documented example.com placeholders as missing", () => {
    writeOwnerOnly(
      ".env-orbit",
      [
        "APP_URL=http://127.0.0.1:3000",
        "ORBIT_AUTH_OIDC=true",
        "OIDC_ISSUER=https://auth.example.com/application/o/orbit/",
        "OIDC_CALLBACK_URL=http://127.0.0.1:3000/api/auth/callback",
        "",
      ].join("\n"),
    );

    const result = check();

    expect(result.status).not.toBe(0);
    expect(result.lines).toContain("missing APP_URL");
    expect(result.lines).toContain("missing OIDC_ISSUER");
    expect(result.lines).toContain("missing OIDC_CALLBACK_URL");
  });

  it("rejects a mutable image tag, and fails closed on a whitespace-only client identity", () => {
    const base = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=ghcr.io/tomlawesome/orbit:latest",
      "ORBIT_AUTH_OIDC=true",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_SECRET=test-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
    ];
    writeOwnerOnly(".env-orbit", [...base, "OIDC_CLIENT_ID=test-client-id", ""].join("\n"));
    const mutable = check();
    expect(mutable.status).not.toBe(0);
    expect(mutable.lines).toContain("missing ORBIT_IMAGE");
    expect(mutable.stdout).not.toContain("latest");

    // bash read `OIDC_CLIENT_ID=   ` loosely and reported it missing; the
    // engine's reader refuses trailing whitespace, so check fails closed.
    writeOwnerOnly(".env-orbit", [...base, "OIDC_CLIENT_ID=   ", ""].join("\n"));
    const whitespace = check();
    expect(whitespace.status).toBe(1);
    expect(whitespace.stdout).toBe("");
    expect(whitespace.stderr).toBe("configuration_syntax\n");
  });

  it("reports direct and file secret conflicts as incomplete without disclosing values", () => {
    writeOwnerOnly(
      ".env-orbit",
      [
        "ORBIT_AUTH_OIDC=true",
        "OIDC_CLIENT_SECRET=private-direct-oidc",
        "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/private-oidc",
        "SMTP_HOST=smtp.example.com",
        "SMTP_USER=orbit@example.com",
        "SMTP_PASSWORD=private-direct-smtp",
        "SMTP_PASSWORD_FILE=/run/orbit-secrets/private-smtp",
        "",
      ].join("\n"),
    );

    const result = check();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("missing OIDC_CLIENT_SECRET\n");
    expect(result.stdout).toContain("missing mail\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-");
  });

  it("reports a file-backed OIDC secret as missing when its permissions are too broad", () => {
    writeOwnerOnly(".env-orbit", `ORBIT_AUTH_OIDC=true\n${CANONICAL_SECRET_FILE}\n`);
    writeSecret("configured-secret-value", 0o640);

    const result = check();

    expect(result.status).not.toBe(0);
    expect(result.lines).toContain("missing OIDC_CLIENT_SECRET");
    expect(result.stdout).not.toContain("configured-secret-value");
  });

  it("reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is empty", () => {
    writeOwnerOnly(".env-orbit", `ORBIT_AUTH_OIDC=true\n${CANONICAL_SECRET_FILE}\n`);
    writeSecret("");

    expect(check().lines).toContain("missing OIDC_CLIENT_SECRET");
  });

  it("reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is a symlink", () => {
    writeOwnerOnly(".env-orbit", `ORBIT_AUTH_OIDC=true\n${CANONICAL_SECRET_FILE}\n`);
    mkdirSync(join(sandbox, ".orbit-secrets"), { mode: 0o700 });
    const target = join(scratch(), "oidc-client-secret");
    writeFileSync(target, "configured-secret-value", { mode: 0o600 });
    symlinkSync(target, join(sandbox, ".orbit-secrets", "oidc-client-secret"));

    const result = check();

    expect(result.lines).toContain("missing OIDC_CLIENT_SECRET");
    expect(result.stdout).not.toContain("configured-secret-value");
  });
});

describe("orbit check --rollback (ported from scripts/configure.test.mjs --check-rollback)", () => {
  const ROLLBACK = ".env-orbit.orbit-config.rollback";
  const goodFileBackedEnv = [
    "APP_URL=https://orbit.configure-test.internal",
    "ORBIT_IMAGE=orbit-local:abcdef123456",
    "ORBIT_AUTH_OIDC=true",
    "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
    "OIDC_CLIENT_ID=test-client-id",
    CANONICAL_SECRET_FILE,
    "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
    "",
  ].join("\n");

  it("passes on a good rollback copy and resolves .orbit-secrets from the real installation directory (file-backed OIDC secret)", () => {
    writeSecret("configured-secret-value");
    writeOwnerOnly(ROLLBACK, goodFileBackedEnv);

    const result = check(["--rollback"]);

    expect(result.status).toBe(0);
    expect(result.lines).toContain("ready APP_URL");
    expect(result.lines).toContain("ready OIDC_CLIENT_SECRET");
    expect(result.stdout).not.toContain("configured-secret-value");
  });

  it("fails closed when the rollback copy is a symlink", () => {
    writeOwnerOnly(".env-orbit.real-rollback", goodFileBackedEnv);
    symlinkSync(join(sandbox, ".env-orbit.real-rollback"), join(sandbox, ROLLBACK));

    const result = check(["--rollback"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("configuration_syntax\n");
  });

  it("fails closed when the rollback copy's permissions are broader than mode 600", () => {
    writeOwnerOnly(ROLLBACK, goodFileBackedEnv);
    chmodSync(join(sandbox, ROLLBACK), 0o644);

    const result = check(["--rollback"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("configuration_syntax\n");
  });

  it("checks only the rollback copy, never the live .env-orbit", () => {
    writeOwnerOnly(
      ".env-orbit",
      [
        "APP_URL=https://orbit.configure-test.internal",
        "ORBIT_IMAGE=orbit-local:abcdef123456",
        "ORBIT_AUTH_OIDC=true",
        "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
        "OIDC_CLIENT_ID=test-client-id",
        "OIDC_CLIENT_SECRET=live-direct-secret",
        "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
        "",
      ].join("\n"),
    );
    // A minimal, incomplete rollback: --rollback must fail even though the
    // live file above is fully ready.
    writeOwnerOnly(ROLLBACK, "APP_URL=https://orbit.configure-test.internal\nORBIT_AUTH_OIDC=true\n");

    expect(check().status).toBe(0);

    const rollback = check(["--rollback"]);
    expect(rollback.status).not.toBe(0);
    expect(rollback.lines).toContain("missing OIDC_CLIENT_SECRET");
  });

  it("rejects an extra argument as a usage error (exit 2), as a plain check does", () => {
    writeOwnerOnly(ROLLBACK, goodFileBackedEnv);

    const result = check(["--rollback", "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage");
  });
});
