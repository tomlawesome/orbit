import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This suite runs configure.sh from copied fixtures in temporary directories:
// the script always cds to its own containing checkout, so it must never be
// pointed at the real repository. Fake `openssl` and `docker` executables are
// placed ahead of the real ones on PATH, so no test needs a real daemon,
// registry, credentials or network access.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(scriptsDir, "..");
const configureScriptSource = readFileSync(join(scriptsDir, "configure.sh"), "utf8");
const installerUiSource = readFileSync(join(scriptsDir, "installer-ui.sh"), "utf8");
const environmentExampleSource = readFileSync(join(repoDir, ".env-orbit.example"), "utf8");

const fakeOpensslScript = [
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

const fakeDockerScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'case "${1:-}" in',
  "  image)",
  "    exit 0",
  "    ;;",
  "  run)",
  "    printf 'public=fake-public-key\\nprivate=%s\\n' \"$(printf 'c%.0s' {1..64})\"",
  "    exit 0",
  "    ;;",
  "  pull)",
  "    exit 0",
  "    ;;",
  "esac",
  "exit 1",
  "",
].join("\n");

const fakeChmodScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ "${ORBIT_TEST_FAIL_UPDATE_CHMOD:-0}" == "1" && "${*: -1}" == *".env-orbit.updating."* ]]; then',
  "  exit 1",
  "fi",
  'exec /usr/bin/chmod "$@"',
  "",
].join("\n");

function makeFakeBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-configure-fakebin-"));
  writeFileSync(join(binDir, "openssl"), fakeOpensslScript);
  chmodSync(join(binDir, "openssl"), 0o755);
  writeFileSync(join(binDir, "docker"), fakeDockerScript);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(join(binDir, "chmod"), fakeChmodScript);
  chmodSync(join(binDir, "chmod"), 0o755);
  return binDir;
}

function makeFixture(envOrbitContent) {
  const targetDir = mkdtempSync(join(tmpdir(), "orbit-configure-target-"));
  mkdirSync(join(targetDir, "scripts"));
  writeFileSync(join(targetDir, "scripts", "configure.sh"), configureScriptSource);
  chmodSync(join(targetDir, "scripts", "configure.sh"), 0o755);
  writeFileSync(join(targetDir, "scripts", "installer-ui.sh"), installerUiSource);
  chmodSync(join(targetDir, "scripts", "installer-ui.sh"), 0o755);
  writeFileSync(join(targetDir, ".env-orbit.example"), environmentExampleSource);
  if (envOrbitContent !== undefined) {
    writeFileSync(join(targetDir, ".env-orbit"), envOrbitContent);
    chmodSync(join(targetDir, ".env-orbit"), 0o600);
  }
  return targetDir;
}

function runConfigure(targetDir, args = [], envOverrides = {}, input = undefined) {
  const binDir = makeFakeBin();
  return spawnSync("bash", [join(targetDir, "scripts", "configure.sh"), ...args], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ORBIT_IMAGE: "orbit-local:abcdef123456",
      ...envOverrides,
    },
  });
}

function runConfigureWithControllingTerminal(targetDir, args = [], envOverrides = {}, input = "") {
  const binDir = makeFakeBin();
  const command = `exec </dev/null; bash ${join(targetDir, "scripts", "configure.sh")} ${args.join(" ")}`;
  return spawnSync("script", ["-qeE", "never", "-c", command, "/dev/null"], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: process.env.HOME ?? tmpdir(),
      ORBIT_IMAGE: "orbit-local:abcdef123456",
      ...envOverrides,
    },
  });
}

function runConfigureWithPipeEOF(targetDir, args = [], envOverrides = {}, input = "") {
  const binDir = makeFakeBin();
  const inputPath = join(targetDir, ".configure-stdin-fixture");
  writeFileSync(inputPath, input);
  const result = spawnSync(
    "bash",
    [
      "-c",
      'cat -- "$1" | bash "$2" "${@:3}"',
      "pipe-runner",
      inputPath,
      join(targetDir, "scripts", "configure.sh"),
      ...args,
    ],
    {
      cwd: targetDir,
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH}`,
        HOME: process.env.HOME ?? tmpdir(),
        ORBIT_IMAGE: "orbit-local:abcdef123456",
        ...envOverrides,
      },
    },
  );
  unlinkSync(inputPath);
  return result;
}

function stagingLeftovers(targetDir) {
  const rootLeftovers = readdirSync(targetDir).filter(
    (name) => name.startsWith(".env-orbit.updating") || name.startsWith(".env-orbit.installing"),
  );
  const secretsDir = join(targetDir, ".orbit-secrets");
  const secretsLeftovers = existsSync(secretsDir)
    ? readdirSync(secretsDir).filter((name) => name.startsWith(".installing") || name.startsWith(".vapid.installing"))
    : [];
  return [...rootLeftovers, ...secretsLeftovers];
}

describe(".env-orbit.example", () => {
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
      "Optional: outbound and inbound mail",
      "Optional: push notifications",
      "Advanced: limits and tuning",
    ]);
  });

  it("keeps the active-assignment surface to the bounded allowlist", () => {
    const activeKeys = [...environmentExampleSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

    expect(activeKeys).toEqual([
      "ORBIT_CONFIG_SCHEMA_VERSION",
      "APP_URL",
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
      "IMAP_ENABLED",
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

  it("leaves optional IMAP inactive by default", () => {
    expect(environmentExampleSource).toMatch(/^IMAP_ENABLED=false$/m);
    expect(environmentExampleSource).not.toMatch(/^IMAP_HOST=/m);
    expect(environmentExampleSource).not.toMatch(/^IMAP_USER=/m);
    expect(environmentExampleSource).not.toMatch(/^IMAP_PASSWORD=/m);
    expect(environmentExampleSource).not.toMatch(/^IMAP_PASSWORD_FILE=/m);
  });

  it("keeps the deprecated SMTP_URL compatibility form out of the active surface", () => {
    expect(environmentExampleSource).not.toMatch(/^SMTP_URL=/m);
    expect(environmentExampleSource).not.toMatch(/^SMTP_URL_FILE=/m);
    expect(environmentExampleSource).toContain("# SMTP_URL=");
    expect(environmentExampleSource).toContain("# SMTP_URL_FILE=");
  });
});

describe("configure.sh", () => {
  it("creates a concise operator environment while leaving reference-only defaults in the example", () => {
    const targetDir = makeFixture(undefined);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8");
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

  it.each([
    ["standard", "", "", ""],
    ["processing", "processing", "http://orbit-tika:9998", ""],
    ["ai", "ai", "", "granite-local:3b"],
    ["full", "processing,ai", "http://orbit-tika:9998", "granite-local:3b"],
  ])("persists the %s deployment profile atomically", (preset, profiles, tikaUrl, model) => {
    const initial = [
      "# operator comment stays",
      "UNMANAGED_VALUE=keep-me",
      "COMPOSE_PROFILES=old",
      "TIKA_URL=old",
      "OLLAMA_MODEL=old",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);
    const args = ["--set-deployment-profile", preset];
    if (model) args.push(model);

    const result = runConfigure(targetDir, args);

    expect(result.status).toBe(0);
    if (model) expect(result.stdout).not.toContain(model);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated.match(/^COMPOSE_PROFILES=.*$/gm)).toEqual([`COMPOSE_PROFILES=${profiles}`]);
    expect(updated.match(/^TIKA_URL=.*$/gm)).toEqual([`TIKA_URL=${tikaUrl}`]);
    expect(updated.match(/^OLLAMA_MODEL=.*$/gm)).toEqual([`OLLAMA_MODEL=${model}`]);
    expect(updated).toContain("# operator comment stays\nUNMANAGED_VALUE=keep-me");

    const rerun = runConfigure(targetDir, args);
    expect(rerun.status).toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(updated);
  });

  it("leaves the environment unchanged when atomic profile staging fails", () => {
    const initial = [
      "# operator comment stays",
      "UNMANAGED_VALUE=keep-me",
      "COMPOSE_PROFILES=old",
      "TIKA_URL=old",
      "OLLAMA_MODEL=old",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(
      targetDir,
      ["--set-deployment-profile", "processing"],
      { ORBIT_TEST_FAIL_UPDATE_CHMOD: "1" },
    );

    expect(result.status).not.toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("rejects missing or hostile local-model identifiers without mutation or disclosure", () => {
    const initial = "COMPOSE_PROFILES=\nTIKA_URL=\nOLLAMA_MODEL=\n";
    const targetDir = makeFixture(initial);

    const missing = runConfigure(targetDir, ["--set-deployment-profile", "full"]);
    expect(missing.status).toBe(2);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);

    const hostileValue = "private-model;print-secret";
    const hostile = runConfigure(targetDir, ["--set-deployment-profile", "full", hostileValue]);
    expect(hostile.status).toBe(2);
    expect(`${hostile.stdout}${hostile.stderr}`).not.toContain(hostileValue);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
  });

  it("updates an existing active ORBIT_IMAGE assignment atomically", () => {
    const initial = [
      "UNRELATED_KEY=keep-me",
      "# a comment stays",
      `ORBIT_IMAGE=old-registry.example/orbit@sha256:${"a".repeat(64)}`,
      "TRAILING_KEY=also-keep",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain("ORBIT_IMAGE=orbit-local:abcdef123456");
    expect(updated).toContain("UNRELATED_KEY=keep-me");
    expect(updated).toContain("# a comment stays");
    expect(updated).toContain("TRAILING_KEY=also-keep");
    expect(updated.match(/^ORBIT_IMAGE=.*$/gm)).toEqual(["ORBIT_IMAGE=orbit-local:abcdef123456"]);
  });

  it("appends ORBIT_IMAGE when no active assignment exists", () => {
    const initial = ["UNRELATED_KEY=keep-me", "# ORBIT_IMAGE=commented-out-stays", ""].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain("UNRELATED_KEY=keep-me");
    expect(updated).toContain("# ORBIT_IMAGE=commented-out-stays");
    expect(updated.match(/^ORBIT_IMAGE=.*$/gm)).toEqual(["ORBIT_IMAGE=orbit-local:abcdef123456"]);
  });

  it("collapses duplicate active ORBIT_IMAGE assignments into one", () => {
    const initial = [
      "UNRELATED_KEY=keep-me",
      `ORBIT_IMAGE=old-registry.example/orbit@sha256:${"a".repeat(64)}`,
      "MIDDLE_KEY=keep-me-too",
      "ORBIT_IMAGE=another-old-value",
      "TRAILING_KEY=also-keep",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated.match(/^ORBIT_IMAGE=.*$/gm)).toEqual(["ORBIT_IMAGE=orbit-local:abcdef123456"]);
    expect(updated).toContain("UNRELATED_KEY=keep-me");
    expect(updated).toContain("MIDDLE_KEY=keep-me-too");
    expect(updated).toContain("TRAILING_KEY=also-keep");
  });

  it("preserves unrelated comments and operator values byte-for-byte", () => {
    const initial = [
      "# Custom comment retained exactly",
      "CUSTOM_OPERATOR_VALUE=some value with spaces and = signs==",
      "ORBIT_IMAGE=",
      "VAPID_PUBLIC_KEY=existing-public-key",
      "VAPID_PRIVATE_KEY_FILE=existing-private-key-file",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated).toContain("# Custom comment retained exactly");
    expect(updated).toContain("CUSTOM_OPERATOR_VALUE=some value with spaces and = signs==");
    expect(updated).toContain("ORBIT_IMAGE=orbit-local:abcdef123456");
    expect(updated).toContain("VAPID_PUBLIC_KEY=fake-public-key");
    expect(updated).toContain("VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key");
  });

  it("preserves an existing file's final newline state around managed updates", () => {
    const initial = [
      "ORBIT_IMAGE=old-registry.example/orbit@sha256:" + "a".repeat(64),
      "# operator comment retained",
      "UNMANAGED_VALUE=keep-me",
      "VAPID_PUBLIC_KEY=existing-public-key",
      "VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key",
    ].join("\n");
    const targetDir = makeFixture(initial);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(targetDir, ".orbit-secrets", "vapid-private-key"), "existing-private-key\n");
    chmodSync(join(targetDir, ".orbit-secrets", "vapid-private-key"), 0o600);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe([
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "# operator comment retained",
      "UNMANAGED_VALUE=keep-me",
      "VAPID_PUBLIC_KEY=existing-public-key",
      "VAPID_PRIVATE_KEY_FILE=/run/orbit-secrets/orbit-vapid-private-key",
    ].join("\n"));
  });

  it("places the canonical OIDC client secret file key in the authentication section", () => {
    const initial = [
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
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, "new-secret-value\n");

    expect(result.status).toBe(0);
    const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
    expect(updated.indexOf("OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret"))
      .toBeGreaterThan(updated.indexOf("OIDC_CLIENT_SECRET="));
    expect(updated.indexOf("OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret"))
      .toBeLessThan(updated.indexOf("OIDC_CALLBACK_URL="));
    expect(updated).toContain("# File-backed form, set only by `scripts/configure.sh --set-oidc-secret`");
    expect(updated).not.toContain("# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret");
    expect(updated).toContain("# unmanaged comment remains\nUNMANAGED_VALUE=keep-me");
    expect(updated.match(/^OIDC_CLIENT_SECRET_FILE=.*$/gm)).toEqual([
      "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    ]);

    const rerun = runConfigure(targetDir, ["--set-oidc-secret"], {}, "replacement-secret-value\n");
    expect(rerun.status).toBe(0);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(updated);
  });

  it("keeps .env-orbit restricted to owner-only permissions", () => {
    const targetDir = makeFixture("ORBIT_IMAGE=old\n");
    chmodSync(join(targetDir, ".env-orbit"), 0o640);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const mode = statSync(join(targetDir, ".env-orbit")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("never discloses configured values in --check mode, only fixed categories and names", () => {
    const initial = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=super-secret-client-id",
      "OIDC_CLIENT_SECRET=super-secret-client-secret-value",
      "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
      "SMTP_HOST=smtp.example.com",
      "SMTP_USER=orbit@example.com",
      "SMTP_PASSWORD=super-secret-smtp-password",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("super-secret");
    expect(result.stdout).not.toContain("smtp.example.com");
    expect(result.stdout).not.toContain("orbit.configure-test.internal");
    expect(result.stdout).not.toContain("auth.configure-test.internal");

    const lines = result.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      expect(line).toMatch(/^(ready|missing|optional) [A-Za-z_]+$/);
    }
    expect(lines).toContain("ready APP_URL");
    expect(lines).toContain("ready ORBIT_IMAGE");
    expect(lines).toContain("ready OIDC_ISSUER");
    expect(lines).toContain("ready OIDC_CLIENT_ID");
    expect(lines).toContain("ready OIDC_CLIENT_SECRET");
    expect(lines).toContain("ready OIDC_CALLBACK_URL");
    expect(lines).toContain("ready mail");
    expect(lines).toContain("optional imap");
    expect(lines).toContain("optional processing");
    expect(lines).toContain("optional ai");
    expect(lines).toContain("optional push");
  });

  it("does not treat example placeholders as configured when the real environment file is absent", () => {
    const targetDir = makeFixture(undefined);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing APP_URL");
    expect(lines).toContain("missing ORBIT_IMAGE");
    expect(lines).toContain("missing OIDC_ISSUER");
    expect(lines).toContain("missing OIDC_CLIENT_ID");
    expect(lines).toContain("missing OIDC_CLIENT_SECRET");
    expect(lines).toContain("missing OIDC_CALLBACK_URL");
    expect(lines).toContain("optional processing");
    expect(lines).toContain("optional ai");
    expect(lines).toContain("optional mail");
    expect(lines).toContain("optional imap");
    expect(lines).toContain("optional push");
  });

  it("treats the historical loopback default and documented example.com placeholders as missing", () => {
    const initial = [
      "APP_URL=http://127.0.0.1:3000",
      "OIDC_ISSUER=https://auth.example.com/application/o/orbit/",
      "OIDC_CALLBACK_URL=http://127.0.0.1:3000/api/auth/callback",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing APP_URL");
    expect(lines).toContain("missing OIDC_ISSUER");
    expect(lines).toContain("missing OIDC_CALLBACK_URL");
  });

  it("rejects a callback URL that does not match the derived APP_URL callback", () => {
    const initial = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=test-client-id",
      "OIDC_CLIENT_SECRET=test-client-secret",
      "OIDC_CALLBACK_URL=https://wrong-host.configure-test.internal/api/auth/callback",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("wrong-host");
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("ready APP_URL");
    expect(lines).toContain("missing OIDC_CALLBACK_URL");
  });

  it("rejects a mutable image tag and whitespace-only client identity", () => {
    const initial = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=ghcr.io/tomlawesome/orbit:latest",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=   ",
      "OIDC_CLIENT_SECRET=test-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing ORBIT_IMAGE");
    expect(lines).toContain("missing OIDC_CLIENT_ID");
    expect(result.stdout).not.toContain("latest");
  });

  it("exits zero for a complete required configuration with all optional groups untouched", () => {
    const initial = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=test-client-id",
      "OIDC_CLIENT_SECRET=test-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("optional processing");
    expect(lines).toContain("optional ai");
    expect(lines).toContain("optional mail");
    expect(lines).toContain("optional imap");
    expect(lines).toContain("optional push");
  });

  it("exits non-zero when an optional group is partially configured even with a complete required set", () => {
    const initial = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=test-client-id",
      "OIDC_CLIENT_SECRET=test-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
      "SMTP_HOST=smtp.example.com",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing mail");
  });

  it("reports inbound mail ready only when its complete trust boundary and outbound mail are configured", () => {
    const initial = [
      "APP_URL=https://orbit.configure-test.internal",
      "ORBIT_IMAGE=orbit-local:abcdef123456",
      "OIDC_ISSUER=https://auth.configure-test.internal/application/o/orbit/",
      "OIDC_CLIENT_ID=test-client-id",
      "OIDC_CLIENT_SECRET=test-client-secret",
      "OIDC_CALLBACK_URL=https://orbit.configure-test.internal/api/auth/callback",
      "IMAP_ENABLED=true",
      "SMTP_HOST=smtp.example.com",
      "SMTP_USER=orbit@example.com",
      "SMTP_PASSWORD=private-smtp-value",
      "IMAP_HOST=imap.example.com",
      "IMAP_USER=orbit@example.com",
      "IMAP_PASSWORD=private-imap-value",
      "IMAP_RECIPIENT_DOMAIN=orbit.example.com",
      "IMAP_ALIAS_CURRENT_GENERATION=1",
      "IMAP_ALIAS_CURRENT_SECRET=private-alias-value",
      "IMAP_TRUSTED_RECIPIENT_HEADER=X-Original-To",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ready mail\n");
    expect(result.stdout).toContain("ready imap\n");
    expect(result.stdout).not.toContain("private-");
  });

  it("reports direct and file secret conflicts as incomplete without disclosing values", () => {
    const initial = [
      "OIDC_CLIENT_SECRET=private-direct-oidc",
      "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/private-oidc",
      "SMTP_HOST=smtp.example.com",
      "SMTP_USER=orbit@example.com",
      "SMTP_PASSWORD=private-direct-smtp",
      "SMTP_PASSWORD_FILE=/run/orbit-secrets/private-smtp",
      "",
    ].join("\n");
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("missing OIDC_CLIENT_SECRET\n");
    expect(result.stdout).toContain("missing mail\n");
    expect(result.stdout).not.toContain("private-");
  });

  it("reports OIDC_CLIENT_SECRET_FILE ready only for the canonical path backed by a non-empty, regular, non-symlink host file", () => {
    const initial = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n";
    const targetDir = makeFixture(initial);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "configured-secret-value");
    chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o600);

    const result = runConfigure(targetDir, ["--check"]);

    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("ready OIDC_CLIENT_SECRET");
    expect(result.stdout).not.toContain("configured-secret-value");
  });

  it("reports a file-backed OIDC secret as missing when its permissions are too broad", () => {
    const initial = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n";
    const targetDir = makeFixture(initial);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "configured-secret-value");
    chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o640);

    const result = runConfigure(targetDir, ["--check"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toContain("missing OIDC_CLIENT_SECRET");
    expect(result.stdout).not.toContain("configured-secret-value");
  });

  it("reports OIDC_CLIENT_SECRET_FILE as missing when the configured path is not the canonical runtime path", () => {
    const initial = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/some-other-path\n";
    const targetDir = makeFixture(initial);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "configured-secret-value");

    const result = runConfigure(targetDir, ["--check"]);

    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing OIDC_CLIENT_SECRET");
  });

  it("reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is absent", () => {
    const initial = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n";
    const targetDir = makeFixture(initial);

    const result = runConfigure(targetDir, ["--check"]);

    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing OIDC_CLIENT_SECRET");
  });

  it("reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is empty", () => {
    const initial = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n";
    const targetDir = makeFixture(initial);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "");

    const result = runConfigure(targetDir, ["--check"]);

    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing OIDC_CLIENT_SECRET");
  });

  it("reports OIDC_CLIENT_SECRET_FILE as missing when the canonical host file is a symlink", () => {
    const initial = "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret\n";
    const targetDir = makeFixture(initial);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    const elsewhere = mkdtempSync(join(tmpdir(), "orbit-configure-elsewhere-"));
    writeFileSync(join(elsewhere, "oidc-client-secret"), "configured-secret-value");
    symlinkSync(join(elsewhere, "oidc-client-secret"), join(targetDir, ".orbit-secrets", "oidc-client-secret"));

    const result = runConfigure(targetDir, ["--check"]);

    const lines = result.stdout.split("\n").filter(Boolean);
    expect(lines).toContain("missing OIDC_CLIENT_SECRET");
  });

  it("rejects an unrecognised argument with a concise usage message", () => {
    const targetDir = makeFixture(undefined);

    const result = runConfigure(targetDir, ["--not-a-real-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
    expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
  });

  it("creates a zero-byte, mode-0600 OIDC client secret placeholder when absent", () => {
    const targetDir = makeFixture(undefined);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const path = join(targetDir, ".orbit-secrets", "oidc-client-secret");
    expect(readFileSync(path, "utf8")).toBe("");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  it("preserves a valid direct OIDC client secret without creating a conflicting file form", () => {
    const targetDir = makeFixture("OIDC_CLIENT_SECRET=existing-direct-secret\n");

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    expect(existsSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
      "OIDC_CLIENT_SECRET=existing-direct-secret",
    );
  });

  it("preserves an existing OIDC client secret file byte-for-byte on an ordinary run", () => {
    const targetDir = makeFixture(undefined);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "existing-oidc-secret-value");
    chmodSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), 0o640);

    const result = runConfigure(targetDir);

    expect(result.status).toBe(0);
    const path = join(targetDir, ".orbit-secrets", "oidc-client-secret");
    expect(readFileSync(path, "utf8")).toBe("existing-oidc-secret-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlinked OIDC client secret file on an ordinary run", () => {
    const targetDir = makeFixture(undefined);
    mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
    const elsewhere = mkdtempSync(join(tmpdir(), "orbit-configure-elsewhere-"));
    writeFileSync(join(elsewhere, "oidc-client-secret"), "not-safe");
    symlinkSync(join(elsewhere, "oidc-client-secret"), join(targetDir, ".orbit-secrets", "oidc-client-secret"));

    const result = runConfigure(targetDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to use");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });

  describe("--set-oidc-secret", () => {
    it("reads the secret from standard input, persists it atomically with mode 0600, and switches to the canonical file-backed path without printing it", () => {
      const targetDir = makeFixture("UNRELATED_KEY=keep-me\n");

      const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, "super-secret-oidc-value\n");

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("super-secret-oidc-value");

      const secretPath = join(targetDir, ".orbit-secrets", "oidc-client-secret");
      expect(readFileSync(secretPath, "utf8")).toBe("super-secret-oidc-value");
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);

      const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
      expect(updated).toContain("UNRELATED_KEY=keep-me");
      expect(updated).toMatch(/^OIDC_CLIENT_SECRET=$/m);
      expect(updated).toContain("OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret");
      expect(updated).not.toContain("super-secret-oidc-value");
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });

    it("accepts terminal-style input with a trailing newline without persisting the newline", () => {
      const targetDir = makeFixture(undefined);

      const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, "terminal-input-value\n");

      expect(result.status).toBe(0);
      expect(readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(
        "terminal-input-value",
      );
    });

    it("rejects empty standard input without creating an environment file or secret", () => {
      const targetDir = makeFixture(undefined);

      const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, "\n");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("non-empty OIDC client secret");
      expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
      expect(existsSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
    });

    it("rejects EOF without a newline instead of accepting a partial secret", () => {
      const targetDir = makeFixture(undefined);

      const result = runConfigureWithPipeEOF(targetDir, ["--set-oidc-secret"], {}, "partial-secret");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("standard input");
      expect(existsSync(join(targetDir, ".env-orbit"))).toBe(false);
      expect(existsSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
    });

    it("rejects a secret larger than the 65,536-byte bound", () => {
      const targetDir = makeFixture(undefined);
      const oversized = "a".repeat(65537);

      const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, `${oversized}\n`);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exceeds the 65536-byte maximum");
      expect(existsSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
    });

    it("applies the 65,536-byte bound to multibyte input rather than character count", () => {
      const targetDir = makeFixture(undefined);
      const oversized = "é".repeat(32769);

      const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, `${oversized}\n`);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exceeds the 65536-byte maximum");
      expect(existsSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"))).toBe(false);
    });

    it("replaces an existing OIDC client secret file and leaves no staging leftovers", () => {
      const targetDir = makeFixture("OIDC_CLIENT_SECRET=old-direct-value\n");
      mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
      writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "old-secret-value");

      const result = runConfigure(targetDir, ["--set-oidc-secret"], {}, "new-secret-value\n");

      expect(result.status).toBe(0);
      expect(readFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe(
        "new-secret-value",
      );
      const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
      expect(updated).toMatch(/^OIDC_CLIENT_SECRET=$/m);
      expect(updated).not.toContain("old-direct-value");
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });
  });

  describe("--init guided configuration", () => {
    const validAppUrl = "https://orbit.guided-test.internal";
    const validIssuer = "https://auth.guided-test.internal/application/o/orbit/";
    const validClientId = "guided-test-client-id";

    it("derives and atomically writes all four values from a complete environment set without printing them", () => {
      const targetDir = makeFixture("UNRELATED_KEY=keep-me\n");

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(validClientId);
      expect(result.stdout).not.toContain("orbit.guided-test.internal");

      const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
      expect(updated).toContain("UNRELATED_KEY=keep-me");
      expect(updated).toContain(`APP_URL=${validAppUrl}`);
      expect(updated).toContain(`OIDC_ISSUER=${validIssuer}`);
      expect(updated).toContain(`OIDC_CLIENT_ID=${validClientId}`);
      expect(updated).toContain(`OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback`);
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });

    it("normalizes one harmless trailing slash from the public Orbit origin", () => {
      const targetDir = makeFixture("UNRELATED_KEY=keep-me\n");

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: `${validAppUrl}/`,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      });

      expect(result.status).toBe(0);
      const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
      expect(updated).toContain(`APP_URL=${validAppUrl}\n`);
      expect(updated).toContain(`OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback\n`);
    });

    it("refuses a partial non-interactive environment input set without mutating the file", () => {
      const initial = "APP_URL=https://old.guided-test.internal\n";
      const targetDir = makeFixture(initial);

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
      });

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("orbit.guided-test.internal");
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });

    it("refuses non-TTY guided mode when no complete environment input set is supplied", () => {
      const initial = "UNRELATED_KEY=keep-me\n";
      const targetDir = makeFixture(initial);

      const result = runConfigure(targetDir, ["--init"]);

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });

    it("uses the controlling terminal when stdin is occupied by the installer script", () => {
      const targetDir = makeFixture("UNRELATED_KEY=keep-me\n");

      const result = runConfigureWithControllingTerminal(
        targetDir,
        ["--init"],
        { TERM: "xterm" },
        `${validAppUrl}\n${validIssuer}\n${validClientId}X\x1b[D\x1b[3~\r`,
      );

      expect(result.status).toBe(0);
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(
        `OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback`,
      );
    });

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
      const targetDir = makeFixture(initial);

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: badAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      });

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
      expect(stagingLeftovers(targetDir)).toEqual([]);
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
      const targetDir = makeFixture(initial);

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: badIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      });

      expect(result.status).not.toBe(0);
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });

    it("collapses duplicate managed keys during a guided write while preserving unrelated lines byte-for-byte", () => {
      const initial = [
        "# Custom comment retained exactly",
        "CUSTOM_OPERATOR_VALUE=some value with spaces and = signs==",
        "APP_URL=https://old.guided-test.internal",
        "APP_URL=https://another-old.guided-test.internal",
        "OIDC_ISSUER=https://old-auth.guided-test.internal/o/orbit/",
        "OIDC_CLIENT_ID=old-client-id",
        "OIDC_CALLBACK_URL=https://old.guided-test.internal/api/auth/callback",
        "TRAILING_KEY=also-keep",
        "",
      ].join("\n");
      const targetDir = makeFixture(initial);

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
      });

      expect(result.status).toBe(0);
      const updated = readFileSync(join(targetDir, ".env-orbit"), "utf8");
      expect(updated).toContain("# Custom comment retained exactly");
      expect(updated).toContain("CUSTOM_OPERATOR_VALUE=some value with spaces and = signs==");
      expect(updated).toContain("TRAILING_KEY=also-keep");
      expect(updated.match(/^APP_URL=.*$/gm)).toEqual([`APP_URL=${validAppUrl}`]);
      expect(updated.match(/^OIDC_ISSUER=.*$/gm)).toEqual([`OIDC_ISSUER=${validIssuer}`]);
      expect(updated.match(/^OIDC_CLIENT_ID=.*$/gm)).toEqual([`OIDC_CLIENT_ID=${validClientId}`]);
      expect(updated.match(/^OIDC_CALLBACK_URL=.*$/gm)).toEqual([
        `OIDC_CALLBACK_URL=${validAppUrl}/api/auth/callback`,
      ]);
    });

    it("removes the guided atomic update file when securing it fails, leaving the original unchanged", () => {
      const initial = "APP_URL=https://old.guided-test.internal\n";
      const targetDir = makeFixture(initial);

      const result = runConfigure(targetDir, ["--init"], {
        ORBIT_CONFIGURE_APP_URL: validAppUrl,
        ORBIT_CONFIGURE_OIDC_ISSUER: validIssuer,
        ORBIT_CONFIGURE_OIDC_CLIENT_ID: validClientId,
        ORBIT_TEST_FAIL_UPDATE_CHMOD: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Could not secure the temporary Orbit environment file");
      expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(initial);
      expect(stagingLeftovers(targetDir)).toEqual([]);
    });
  });

  it("leaves no temporary files behind after success or a later failure", () => {
    const targetDir = makeFixture("ORBIT_IMAGE=old\n");
    const successResult = runConfigure(targetDir);
    expect(successResult.status).toBe(0);
    expect(stagingLeftovers(targetDir)).toEqual([]);

    const failureDir = makeFixture("ORBIT_IMAGE=old\n");
    mkdirSync(join(failureDir, ".orbit-secrets"), { mode: 0o700 });
    const elsewhere = mkdtempSync(join(tmpdir(), "orbit-configure-elsewhere-"));
    writeFileSync(join(elsewhere, "session-secret"), "not-a-valid-secret");
    symlinkSync(join(elsewhere, "session-secret"), join(failureDir, ".orbit-secrets", "session-secret"));

    const failureResult = runConfigure(failureDir);
    expect(failureResult.status).not.toBe(0);
    expect(failureResult.stderr).toContain("Refusing to use");
    expect(stagingLeftovers(failureDir)).toEqual([]);
  });

  it("removes the atomic update file when securing it fails", () => {
    const targetDir = makeFixture("ORBIT_IMAGE=old\n");

    const result = runConfigure(targetDir, [], { ORBIT_TEST_FAIL_UPDATE_CHMOD: "1" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not secure the temporary Orbit environment file");
    expect(stagingLeftovers(targetDir)).toEqual([]);
  });
});
