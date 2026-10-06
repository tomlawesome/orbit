import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigureEngineRefusal,
  ENVIRONMENT_EXAMPLE_NAME,
  ENVIRONMENT_FILE_NAME,
  SECRETS_DIRECTORY_NAME,
  applyGuidedInit,
  applySetOidcSecret,
  runConfigureApply,
  setDeploymentProfile,
} from "./configure-engine";

// The cases of the retired scripts/configure.test.mjs that no other engine
// test covered, ported onto the engine before that suite was deleted
// (#1210 build note D10; the mapping is docs/adr-notes/1210-bash-test-
// retirement.md). Each keeps its bash title, setup and assertions. Two
// changes are forced by the port, not chosen: a fixture that goes through
// the bare flow carries ORBIT_CONFIG_SCHEMA_VERSION=1 and only contract
// keys, because the bash suite ran configure.sh without configuration.sh
// beside it, which skipped the preflight production always ran; and the
// fake `chmod` that failed on the staging file is a failure to hand that
// file over (src/lib/host-ownership.ts), the one step the engine runs
// between writing it and renaming it into place.

const failStaging = vi.hoisted(() => ({ pattern: undefined as RegExp | undefined }));

vi.mock("./host-ownership", async (importOriginal) => {
  const real = await importOriginal<typeof import("./host-ownership")>();
  return {
    ...real,
    applyHostOwnership: (path: string, env?: NodeJS.ProcessEnv) => {
      if (failStaging.pattern?.test(path)) {
        throw new real.HostOwnershipError(`Could not hand ${path} to the host operator (EPERM).`);
      }
      real.applyHostOwnership(path, env);
    },
  };
});

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const environmentExampleSource = readFileSync(join(repoRoot, ENVIRONMENT_EXAMPLE_NAME), "utf8");
const IMAGE = "orbit-local:abcdef123456";

let deployDir: string;

beforeEach(() => {
  deployDir = mkdtempSync(join(tmpdir(), "orbit-configure-retired-bash-"));
  writeFileSync(join(deployDir, ENVIRONMENT_EXAMPLE_NAME), environmentExampleSource);
});

afterEach(() => {
  failStaging.pattern = undefined;
  rmSync(deployDir, { recursive: true, force: true });
});

function envPath(): string {
  return join(deployDir, ENVIRONMENT_FILE_NAME);
}

function readEnv(): string {
  return readFileSync(envPath(), "utf8");
}

function writeEnv(content: string): void {
  writeFileSync(envPath(), content, { mode: 0o600 });
  chmodSync(envPath(), 0o600);
}

function secretsPath(name: string): string {
  return join(deployDir, SECRETS_DIRECTORY_NAME, name);
}

/** scripts/configure.test.mjs's stagingLeftovers: any atomic-write scratch file left in the deployment or its secrets directory. */
function stagingLeftovers(): string[] {
  const isScratch = (name: string) => name.includes(".installing.") || name.includes(".updating.");
  const root = readdirSync(deployDir).filter(isScratch);
  const secretsDir = join(deployDir, SECRETS_DIRECTORY_NAME);
  const secrets = existsSync(secretsDir) ? readdirSync(secretsDir).filter(isScratch) : [];
  return [...root, ...secrets];
}

function refusalOf(action: () => unknown): ConfigureEngineRefusal {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigureEngineRefusal);
    return error as ConfigureEngineRefusal;
  }
  throw new Error("expected a refusal");
}

describe(".env-orbit.example (ported from scripts/configure.test.mjs)", () => {
  it("orders its headings as required", () => {
    const headings = environmentExampleSource
      .split("\n")
      .filter((line) => line.startsWith("# --- "))
      .map((line) => line.replace(/^# --- /, "").replace(/ -+$/, ""));

    expect(headings).toEqual([
      "Required: public URL and authentication",
      "Installer-managed: image and generated values",
      "Ordinary deployment exposure",
      "Optional: document processing",
      "Optional: outbound mail",
      "Optional: push notifications",
      "Advanced: limits and tuning",
    ]);
  });

  it("keeps the active-assignment surface to the bounded allowlist", () => {
    const activeKeys = [...environmentExampleSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

    expect(activeKeys).toEqual([
      "ORBIT_CONFIG_SCHEMA_VERSION",
      "APP_URL",
      "ORBIT_AUTH_OIDC",
      "OIDC_ISSUER",
      "OIDC_CLIENT_ID",
      "OIDC_CLIENT_SECRET",
      "OIDC_CALLBACK_URL",
      "ORBIT_IMAGE",
      "SESSION_SECRET_FILE",
      "DOCUMENT_KEK_FILE",
      "POSTGRES_PASSWORD_FILE",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY_FILE",
      "ORBIT_BIND_ADDRESS",
      "ORBIT_PORT",
      "ORBIT_LOG_LEVEL",
      "ORBIT_LOG_FORMAT",
      "COMPOSE_PROFILES",
      "POSTGRES_DB",
      "POSTGRES_USER",
      "TIKA_URL",
      "OLLAMA_MODEL",
    ]);
  });

  it("uses HTTPS for every ordinary production URL example", () => {
    expect(environmentExampleSource).toContain("APP_URL=https://orbit.example.com");
    expect(environmentExampleSource).toContain("OIDC_ISSUER=https://auth.example.com/application/o/orbit/");
    expect(environmentExampleSource).toContain("OIDC_CALLBACK_URL=https://orbit.example.com/api/auth/callback");

    const httpLines = environmentExampleSource.split("\n").filter((line) => line.includes("http://"));
    expect(httpLines.length).toBeGreaterThan(0);
    for (const line of httpLines) {
      expect(line.trim().startsWith("#")).toBe(true);
      expect(line.includes("127.0.0.1") || line.includes("orbit-tika")).toBe(true);
    }
    expect(environmentExampleSource).not.toMatch(/^[A-Z_]+=http:\/\//m);
  });

  it("documents no IMAP_* key: inbound mail is configured on the administration screen (ADR-0017)", () => {
    expect(environmentExampleSource).not.toMatch(/^#?\s*IMAP_[A-Z_]*=/m);
  });

  it("keeps the deprecated SMTP_URL compatibility form out of the active surface", () => {
    expect(environmentExampleSource).not.toMatch(/^SMTP_URL=/m);
    expect(environmentExampleSource).not.toMatch(/^SMTP_URL_FILE=/m);
    expect(environmentExampleSource).toContain("# SMTP_URL=");
    expect(environmentExampleSource).toContain("# SMTP_URL_FILE=");
  });
});

describe("the bare flow (ported from scripts/configure.test.mjs)", () => {
  it("creates a concise operator environment while leaving reference-only defaults in the example", () => {
    runConfigureApply(deployDir, IMAGE, { trustOrbitImage: true });

    const environment = readEnv();
    expect(environment).toContain("# --- Core ---\n");
    expect(environment).toContain("# --- Authentication ---\n");
    expect(environment).toContain("# --- Deployment ---\n");
    expect(environment).toContain("# --- Optional services ---\n");
    expect(environment).toContain("# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n");
    expect(environment).toContain("# ORBIT_CONFIG_APPLIED_VERSION=\n");
    expect(environment).toContain("# ORBIT_CONFIG_APPLIED_DIGEST=\n");
    expect(environment).toContain("# COMPOSE_PROJECT_NAME=\n");
    expect(environment).not.toContain("TIKA_TIMEOUT_MS");
    expect(environment).not.toContain("Advanced: limits and tuning");
    expect(environment.split("\n").length).toBeLessThan(40);
    expect(environmentExampleSource).toContain("# TIKA_TIMEOUT_MS=45000");
  });

  it("updates an existing active ORBIT_IMAGE assignment atomically", () => {
    writeEnv(
      [
        "ORBIT_CONFIG_SCHEMA_VERSION=1",
        "POSTGRES_DB=keep-me",
        "# a comment stays",
        `ORBIT_IMAGE=old-registry.example/orbit@sha256:${"a".repeat(64)}`,
        "POSTGRES_USER=also-keep",
        "",
      ].join("\n"),
    );

    const result = runConfigureApply(deployDir, IMAGE, { trustOrbitImage: true });

    expect(result.messages.filter((message) => message.includes("ignoring"))).toEqual([]);
    const updated = readEnv();
    expect(updated).toContain("POSTGRES_DB=keep-me");
    expect(updated).toContain("# a comment stays");
    expect(updated).toContain("POSTGRES_USER=also-keep");
    expect(updated.match(/^ORBIT_IMAGE=.*$/gm)).toEqual([`ORBIT_IMAGE=${IMAGE}`]);
    expect(stagingLeftovers()).toEqual([]);
  });

  it("appends ORBIT_IMAGE when no active assignment exists", () => {
    writeEnv(["ORBIT_CONFIG_SCHEMA_VERSION=1", "POSTGRES_DB=keep-me", "# ORBIT_IMAGE=commented-out-stays", ""].join("\n"));

    runConfigureApply(deployDir, IMAGE, { trustOrbitImage: true });

    const updated = readEnv();
    expect(updated).toContain("POSTGRES_DB=keep-me");
    expect(updated).toContain("# ORBIT_IMAGE=commented-out-stays");
    expect(updated.match(/^ORBIT_IMAGE=.*$/gm)).toEqual([`ORBIT_IMAGE=${IMAGE}`]);
  });

  it("preserves unrelated comments and operator values byte-for-byte", () => {
    writeEnv(
      [
        "ORBIT_CONFIG_SCHEMA_VERSION=1",
        "# Custom comment retained exactly",
        "POSTGRES_DB=some value with spaces and = signs==",
        "ORBIT_IMAGE=",
        "VAPID_PUBLIC_KEY=existing-public-key",
        "VAPID_PRIVATE_KEY_FILE=existing-private-key-file",
        "",
      ].join("\n"),
    );

    runConfigureApply(deployDir, IMAGE, { trustOrbitImage: true });

    const updated = readEnv();
    expect(updated).toContain("# Custom comment retained exactly\n");
    expect(updated).toContain("POSTGRES_DB=some value with spaces and = signs==\n");
    expect(updated).toContain(`ORBIT_IMAGE=${IMAGE}\n`);
    // No private key file existed, so a fresh pair replaces the stale public key.
    expect(updated).toMatch(/^VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}$/m);
    expect(updated).toContain("VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key\n");
  });

  it("preserves an existing file's final newline state around managed updates", () => {
    writeEnv(
      [
        "ORBIT_CONFIG_SCHEMA_VERSION=1",
        `ORBIT_IMAGE=old-registry.example/orbit@sha256:${"a".repeat(64)}`,
        "# operator comment retained",
        "POSTGRES_DB=keep-me",
        "VAPID_PUBLIC_KEY=existing-public-key",
        "VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key",
      ].join("\n"),
    );
    mkdirSync(join(deployDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    writeFileSync(secretsPath("vapid-private-key"), "existing-private-key\n", { mode: 0o600 });

    runConfigureApply(deployDir, IMAGE, { trustOrbitImage: true });

    expect(readEnv()).toBe(
      [
        "ORBIT_CONFIG_SCHEMA_VERSION=1",
        `ORBIT_IMAGE=${IMAGE}`,
        "# operator comment retained",
        "POSTGRES_DB=keep-me",
        "VAPID_PUBLIC_KEY=existing-public-key",
        "VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key",
      ].join("\n"),
    );
  });

  it("preserves an existing OIDC client secret file byte-for-byte on an ordinary run", () => {
    mkdirSync(join(deployDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    writeFileSync(secretsPath("oidc-client-secret"), "existing-oidc-secret-value");
    chmodSync(secretsPath("oidc-client-secret"), 0o640);

    runConfigureApply(deployDir, IMAGE);

    expect(readFileSync(secretsPath("oidc-client-secret"), "utf8")).toBe("existing-oidc-secret-value");
    expect(statSync(secretsPath("oidc-client-secret")).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary files behind after success or a later failure", () => {
    runConfigureApply(deployDir, IMAGE);
    expect(stagingLeftovers()).toEqual([]);

    rmSync(deployDir, { recursive: true, force: true });
    deployDir = mkdtempSync(join(tmpdir(), "orbit-configure-retired-bash-"));
    writeFileSync(join(deployDir, ENVIRONMENT_EXAMPLE_NAME), environmentExampleSource);
    mkdirSync(join(deployDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    const elsewhere = mkdtempSync(join(tmpdir(), "orbit-configure-retired-bash-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "session-secret"), "not-a-valid-secret");
      symlinkSync(join(elsewhere, "session-secret"), secretsPath("session-secret"));

      const refusal = refusalOf(() => runConfigureApply(deployDir, IMAGE));
      expect(refusal.message).toContain("Refusing to use");
      expect(stagingLeftovers()).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("removes the atomic update file when securing it fails", () => {
    const initial = ["ORBIT_CONFIG_SCHEMA_VERSION=1", "ORBIT_IMAGE=", ""].join("\n");
    writeEnv(initial);
    failStaging.pattern = /\.env-orbit\.updating\./u;

    const refusal = refusalOf(() => runConfigureApply(deployDir, IMAGE, { trustOrbitImage: true }));

    expect(refusal.message).toContain("to the host operator");
    expect(readEnv()).toBe(initial);
    expect(stagingLeftovers()).toEqual([]);
  });

  it("refuses for postgres-password and generates nothing when only session-secret already exists", () => {
    writeEnv("ORBIT_CONFIG_SCHEMA_VERSION=1\n");
    mkdirSync(join(deployDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    writeFileSync(secretsPath("session-secret"), `${"a".repeat(64)}\n`, { mode: 0o600 });

    const refusal = refusalOf(() => runConfigureApply(deployDir, IMAGE));

    expect(refusal.message).toContain(".orbit-secrets/postgres-password is missing on an existing Orbit deployment");
    expect(refusal.message).toContain("Refusing to generate a replacement");
    expect(existsSync(secretsPath("postgres-password"))).toBe(false);
    expect(existsSync(secretsPath("document-kek"))).toBe(false);
  });
});

describe("--set-deployment-profile (ported from scripts/configure.test.mjs)", () => {
  const initial = [
    "# operator comment stays",
    "UNMANAGED_VALUE=keep-me",
    "COMPOSE_PROFILES=old",
    "TIKA_URL=old",
    "OLLAMA_MODEL=old",
    "",
  ].join("\n");

  it.each([
    ["standard", "", "", ""],
    ["processing", "processing", "http://orbit-tika:9998", ""],
    ["ai", "ai", "", "granite-local:3b"],
    ["full", "processing,ai", "http://orbit-tika:9998", "granite-local:3b"],
  ])("persists the %s deployment profile atomically", (preset, profiles, tikaUrl, model) => {
    writeEnv(initial);

    const message = setDeploymentProfile(deployDir, preset, model || undefined);

    if (model) expect(message).not.toContain(model);
    const updated = readEnv();
    expect(updated.match(/^COMPOSE_PROFILES=.*$/gm)).toEqual([`COMPOSE_PROFILES=${profiles}`]);
    expect(updated.match(/^TIKA_URL=.*$/gm)).toEqual([`TIKA_URL=${tikaUrl}`]);
    expect(updated.match(/^OLLAMA_MODEL=.*$/gm)).toEqual([`OLLAMA_MODEL=${model}`]);
    expect(updated).toContain("# operator comment stays\nUNMANAGED_VALUE=keep-me");

    setDeploymentProfile(deployDir, preset, model || undefined);
    expect(readEnv()).toBe(updated);
    expect(stagingLeftovers()).toEqual([]);
  });

  it("leaves the environment unchanged when atomic profile staging fails", () => {
    writeEnv(initial);
    failStaging.pattern = /\.env-orbit\.updating\./u;

    refusalOf(() => setDeploymentProfile(deployDir, "processing", undefined));

    expect(readEnv()).toBe(initial);
    expect(stagingLeftovers()).toEqual([]);
  });
});

describe("--set-oidc-secret (ported from scripts/configure.test.mjs)", () => {
  it("places the canonical OIDC client secret file key in the authentication section", () => {
    writeEnv(
      [
        "# --- Required: public URL and authentication --------------------------------",
        "APP_URL=https://orbit.configure-test.internal",
        "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
        "OIDC_CLIENT_ID=test-client-id",
        "OIDC_CLIENT_SECRET=",
        "# File-backed form, set only by `scripts/configure.sh --set-oidc-secret`",
        "# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
        "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
        "# unmanaged comment remains",
        "UNMANAGED_VALUE=keep-me",
        "OIDC_CLIENT_SECRET_FILE=/old/noncanonical/location",
        "",
      ].join("\n"),
    );

    applySetOidcSecret(deployDir, "new-secret-value");

    const updated = readEnv();
    const canonical = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret";
    expect(updated.indexOf(canonical)).toBeGreaterThan(updated.indexOf("OIDC_CLIENT_SECRET="));
    expect(updated.indexOf(canonical)).toBeLessThan(updated.indexOf("OIDC_CALLBACK_URL="));
    expect(updated).toContain("# File-backed form, set only by `scripts/configure.sh --set-oidc-secret`");
    expect(updated).not.toContain(`# ${canonical}`);
    expect(updated).toContain("# unmanaged comment remains\nUNMANAGED_VALUE=keep-me");
    expect(updated.match(/^OIDC_CLIENT_SECRET_FILE=.*$/gm)).toEqual([canonical]);

    applySetOidcSecret(deployDir, "replacement-secret-value");
    expect(readEnv()).toBe(updated);
  });

  it("applies the 65,536-byte bound to multibyte input rather than character count", () => {
    const oversized = "é".repeat(32769);

    const refusal = refusalOf(() => applySetOidcSecret(deployDir, oversized));

    expect(refusal.message).toContain("exceeds the 65536-byte maximum");
    expect(refusal.message).not.toContain(oversized);
    expect(existsSync(secretsPath("oidc-client-secret"))).toBe(false);
  });

  it("leaves an LF file entirely LF, gaining no stray carriage returns", () => {
    writeEnv("UNRELATED_KEY=keep-me\nOIDC_CLIENT_SECRET=old-direct-value\n");

    applySetOidcSecret(deployDir, "new-secret-value");

    expect(readEnv()).not.toContain("\r");
  });

  it("converges byte-identically when --set-oidc-secret runs twice with the same secret", () => {
    writeEnv("UNRELATED_KEY=keep-me\n");

    applySetOidcSecret(deployDir, "same-secret-value");
    const afterFirst = readEnv();
    applySetOidcSecret(deployDir, "same-secret-value");

    expect(readEnv()).toBe(afterFirst);
    expect(stagingLeftovers()).toEqual([]);
  });

  it("replaces an existing OIDC client secret file and leaves no staging leftovers", () => {
    writeEnv("OIDC_CLIENT_SECRET=old-direct-value\n");
    mkdirSync(join(deployDir, SECRETS_DIRECTORY_NAME), { mode: 0o700 });
    writeFileSync(secretsPath("oidc-client-secret"), "old-secret-value");

    applySetOidcSecret(deployDir, "new-secret-value");

    expect(readFileSync(secretsPath("oidc-client-secret"), "utf8")).toBe("new-secret-value");
    const updated = readEnv();
    expect(updated).toMatch(/^OIDC_CLIENT_SECRET=$/m);
    expect(updated).not.toContain("old-direct-value");
    expect(stagingLeftovers()).toEqual([]);
  });
});

describe("--init guided configuration (ported from scripts/configure.test.mjs)", () => {
  const validAppUrl = "https://orbit.guided-test.internal";
  const validIssuer = "https://auth.guided-test.internal/application/o/orbit/";
  const validClientId = "guided-test-client-id";

  it.each([
    ["http://orbit.guided-test.internal", "non-HTTPS scheme"],
    ["https://127.0.0.1:3000", "loopback address"],
    ["https://orbit.example.com", "documented example.com placeholder"],
    ["https://user:pass@orbit.guided-test.internal", "embedded credentials"],
    ["https://orbit.guided-test.internal/app", "path component"],
    ["https://orbit.guided-test.internal?x=1", "query component"],
    ["https://orbit.guided-test.internal#frag", "fragment component"],
    ["https://", "malformed hostless value"],
    ["https://orbit.guided-test.internal\t", "trailing control character"],
    ["https://orbit.guided-test.internal:70000", "out-of-range port"],
  ])("refuses an invalid APP_URL %s (%s) without mutation", (badAppUrl) => {
    const initial = "UNRELATED_KEY=keep-me\n";
    writeEnv(initial);

    refusalOf(() => applyGuidedInit(deployDir, { appUrl: badAppUrl, issuer: validIssuer, clientId: validClientId }));

    expect(readEnv()).toBe(initial);
    expect(stagingLeftovers()).toEqual([]);
  });

  it.each([
    ["http://auth.guided-test.internal/o/orbit/", "non-HTTPS scheme"],
    ["https://127.0.0.1/o/orbit/", "loopback address"],
    ["https://auth.example.com/o/orbit/", "documented example.com placeholder"],
    ["https://user:pass@auth.guided-test.internal/o/orbit/", "embedded credentials"],
    ["https://auth.guided-test.internal/o/orbit/?x=1", "query component"],
    ["https://auth.guided-test.internal/o/orbit/#frag", "fragment component"],
    ["https://", "malformed hostless value"],
    ["https://auth.guided-test.internal:70000/o/orbit/", "out-of-range port"],
  ])("refuses an invalid OIDC_ISSUER %s (%s) without mutation", (badIssuer) => {
    const initial = "UNRELATED_KEY=keep-me\n";
    writeEnv(initial);

    refusalOf(() => applyGuidedInit(deployDir, { appUrl: validAppUrl, issuer: badIssuer, clientId: validClientId }));

    expect(readEnv()).toBe(initial);
    expect(stagingLeftovers()).toEqual([]);
  });

  it("collapses duplicate managed keys during a guided write while preserving unrelated lines byte-for-byte", () => {
    writeEnv(
      [
        "# Custom comment retained exactly",
        "CUSTOM_OPERATOR_VALUE=some value with spaces and = signs==",
        "APP_URL=https://old.guided-test.internal",
        "APP_URL=https://another-old.guided-test.internal",
        "OIDC_ISSUER=https://old-auth.guided-test.internal/o/orbit/",
        "OIDC_CLIENT_ID=old-client-id",
        "OIDC_CALLBACK_URL=https://old.guided-test.internal/api/auth/callback",
        "TRAILING_KEY=also-keep",
        "",
      ].join("\n"),
    );

    applyGuidedInit(deployDir, { appUrl: validAppUrl, issuer: validIssuer, clientId: validClientId });

    const updated = readEnv();
    expect(updated).toContain("# Custom comment retained exactly");
    expect(updated).toContain("CUSTOM_OPERATOR_VALUE=some value with spaces and = signs==");
    expect(updated).toContain("TRAILING_KEY=also-keep");
    expect(updated.match(/^APP_URL=.*$/gm)).toEqual([`APP_URL=${validAppUrl}`]);
    expect(updated.match(/^OIDC_ISSUER=.*$/gm)).toEqual([`OIDC_ISSUER=${validIssuer}`]);
    expect(updated.match(/^OIDC_CLIENT_ID=.*$/gm)).toEqual([`OIDC_CLIENT_ID=${validClientId}`]);
    expect(updated.match(/^OIDC_CALLBACK_URL=.*$/gm)).toEqual([`OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback`]);
  });

  it("removes the guided atomic update file when securing it fails, leaving the original unchanged", () => {
    const initial = "APP_URL=https://old.guided-test.internal\n";
    writeEnv(initial);
    failStaging.pattern = /\.env-orbit\.updating\./u;

    const refusal = refusalOf(() => applyGuidedInit(deployDir, { appUrl: validAppUrl, issuer: validIssuer, clientId: validClientId }));

    expect(refusal.message).toContain("to the host operator");
    expect(readEnv()).toBe(initial);
    expect(stagingLeftovers()).toEqual([]);
  });
});
