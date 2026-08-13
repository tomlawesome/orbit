import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CANONICAL_OIDC_SECRET_FILE_PATH } from "./config-contract";
import {
  ConfigureEngineRefusal,
  ConfigureMachinePromptAbortedError,
  ENVIRONMENT_EXAMPLE_NAME,
  ENVIRONMENT_FILE_NAME,
  MAXIMUM_SECRET_BYTES,
  OIDC_SECRET_RELATIVE_PATH,
  SECRETS_DIRECTORY_NAME,
  applyGuidedInit,
  applySetOidcSecret,
  collectMachineGuidedInit,
  collectMachineOidcSecret,
  ensureEnvironmentFile,
  ensureOidcSecretPlaceholder,
  ensureSecretFile,
  ensureSecretsDirectory,
  internal,
  persistOrbitImage,
  runConfigureApply,
  runConfigurePreflight,
  setDeploymentProfile,
  updateManagedKeys,
  type ConfigureMachinePromptDriver,
} from "./configure-engine";

// Ported from scripts/configure.sh's write flows (issue #294, completing the
// port begun for --check). Guarantee numbers below cite
// docs/installer-guarantees.md's `configure.sh` section (items 1-33).

const EXAMPLE_CONTENT = `ORBIT_CONFIG_SCHEMA_VERSION=1

APP_URL=https://orbit.example.com
OIDC_ISSUER=https://auth.example.com/application/o/orbit/
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret
OIDC_CALLBACK_URL=https://orbit.example.com/api/auth/callback

ORBIT_IMAGE=
# COMPOSE_PROJECT_NAME=orbit
SESSION_SECRET_FILE=.orbit-secrets/session-secret
DOCUMENT_KEK_FILE=.orbit-secrets/document-kek
POSTGRES_PASSWORD_FILE=.orbit-secrets/postgres-password
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY_FILE=

ORBIT_BIND_ADDRESS=0.0.0.0
ORBIT_PORT=3000
ORBIT_LOG_LEVEL=info
ORBIT_LOG_FORMAT=text
COMPOSE_PROFILES=
POSTGRES_DB=orbit
POSTGRES_USER=orbit

TIKA_URL=
OLLAMA_MODEL=
IMAP_ENABLED=false
`;

let deployDir: string;

beforeEach(() => {
  deployDir = mkdtempSync(join(tmpdir(), "orbit-configure-engine-"));
  writeFileSync(join(deployDir, ENVIRONMENT_EXAMPLE_NAME), EXAMPLE_CONTENT);
});

afterEach(() => {
  rmSync(deployDir, { recursive: true, force: true });
});

function envPath(): string {
  return join(deployDir, ENVIRONMENT_FILE_NAME);
}

function readEnv(): string {
  return readFileSync(envPath(), "utf8");
}

describe("ensureEnvironmentFile", () => {
  it("guarantee #4: refuses when .env-orbit.example is missing", () => {
    rmSync(join(deployDir, ENVIRONMENT_EXAMPLE_NAME));
    expect(() => ensureEnvironmentFile(deployDir)).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #6: creates a fresh, mode-0600 file assembled atomically from the example", () => {
    const result = ensureEnvironmentFile(deployDir);
    expect(result.created).toBe(true);
    expect(result.message).toBe(`Created ${ENVIRONMENT_FILE_NAME} from ${ENVIRONMENT_EXAMPLE_NAME}.`);
    const stat = statSync(envPath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readEnv()).toContain("ORBIT_CONFIG_SCHEMA_VERSION=1");
    expect(readEnv()).toContain("# OIDC_CLIENT_SECRET_FILE=" + CANONICAL_OIDC_SECRET_FILE_PATH);
  });

  it("guarantee #5: refuses a symlinked .env-orbit", () => {
    const targetFile = join(deployDir, "elsewhere");
    writeFileSync(targetFile, "APP_URL=https://x\n");
    symlinkSync(targetFile, envPath());
    expect(() => ensureEnvironmentFile(deployDir)).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #5: forces an existing regular file's permissions to 600", () => {
    writeFileSync(envPath(), "APP_URL=https://x\n", { mode: 0o644 });
    const result = ensureEnvironmentFile(deployDir);
    expect(result.created).toBe(false);
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
  });

  it("replaces a dangling symlink at .env-orbit (bash `-e` semantics: absent, not refused)", () => {
    symlinkSync(join(deployDir, "does-not-exist"), envPath());
    const result = ensureEnvironmentFile(deployDir);
    expect(result.created).toBe(true);
    expect(lstatSync(envPath()).isSymbolicLink()).toBe(false);
  });
});

describe("updateManagedKeys", () => {
  beforeEach(() => {
    ensureEnvironmentFile(deployDir);
  });

  it("guarantee #7: updates an existing active assignment in place", () => {
    writeFileSync(envPath(), "APP_URL=https://old.example.com\nOTHER=1\n", { mode: 0o600 });
    updateManagedKeys(deployDir, [["APP_URL", "https://new.example.com"]]);
    expect(readEnv()).toBe("APP_URL=https://new.example.com\nOTHER=1\n");
  });

  it("guarantee #7: appends a key with no existing assignment, in call order", () => {
    writeFileSync(envPath(), "OTHER=1\n", { mode: 0o600 });
    updateManagedKeys(deployDir, [
      ["FIRST", "a"],
      ["SECOND", "b"],
    ]);
    expect(readEnv()).toBe("OTHER=1\nFIRST=a\nSECOND=b\n");
  });

  it("guarantee #7: collapses duplicate active assignments into one, at the first occurrence", () => {
    writeFileSync(envPath(), "ORBIT_IMAGE=old1\nOTHER=1\nORBIT_IMAGE=old2\n", { mode: 0o600 });
    updateManagedKeys(deployDir, [["ORBIT_IMAGE", "new"]]);
    expect(readEnv()).toBe("ORBIT_IMAGE=new\nOTHER=1\n");
  });

  it("guarantee #7: preserves unrelated comments and operator values byte-for-byte", () => {
    const original = "# a comment\nAPP_URL=https://old.example.com\n# another comment\nUNMANAGED=kept\n";
    writeFileSync(envPath(), original, { mode: 0o600 });
    updateManagedKeys(deployDir, [["APP_URL", "https://new.example.com"]]);
    expect(readEnv()).toBe("# a comment\nAPP_URL=https://new.example.com\n# another comment\nUNMANAGED=kept\n");
  });

  it("guarantee #7: preserves a file's lack of a final newline when nothing is appended", () => {
    writeFileSync(envPath(), "APP_URL=https://old.example.com", { mode: 0o600 });
    updateManagedKeys(deployDir, [["APP_URL", "https://new.example.com"]]);
    expect(readEnv()).toBe("APP_URL=https://new.example.com");
  });

  it("forces a trailing newline when a key must be appended, even onto a file with none", () => {
    writeFileSync(envPath(), "OTHER=1", { mode: 0o600 });
    updateManagedKeys(deployDir, [["APP_URL", "https://new.example.com"]]);
    expect(readEnv()).toBe("OTHER=1\nAPP_URL=https://new.example.com\n");
  });

  it("guarantee #8: relocates OIDC_CLIENT_SECRET_FILE to the commented placeholder position", () => {
    const original = [
      "OIDC_CLIENT_SECRET_FILE=/some/stale/path",
      "OIDC_ISSUER=https://auth.example.com/",
      "OIDC_CLIENT_ID=abc",
      "# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
      "OIDC_CALLBACK_URL=https://x/api/auth/callback",
    ].join("\n") + "\n";
    writeFileSync(envPath(), original, { mode: 0o600 });
    updateManagedKeys(deployDir, [["OIDC_CLIENT_SECRET_FILE", CANONICAL_OIDC_SECRET_FILE_PATH]]);
    expect(readEnv()).toBe(
      [
        "OIDC_ISSUER=https://auth.example.com/",
        "OIDC_CLIENT_ID=abc",
        `OIDC_CLIENT_SECRET_FILE=${CANONICAL_OIDC_SECRET_FILE_PATH}`,
        "OIDC_CALLBACK_URL=https://x/api/auth/callback",
      ].join("\n") + "\n",
    );
  });

  it("guarantee #8: relocates OIDC_CLIENT_SECRET_FILE immediately after an active OIDC_CLIENT_SECRET= line when no commented selector exists", () => {
    const original = "OIDC_CLIENT_SECRET=\nOIDC_CALLBACK_URL=https://x/api/auth/callback\n";
    writeFileSync(envPath(), original, { mode: 0o600 });
    updateManagedKeys(deployDir, [["OIDC_CLIENT_SECRET_FILE", CANONICAL_OIDC_SECRET_FILE_PATH]]);
    expect(readEnv()).toBe(
      `OIDC_CLIENT_SECRET=\nOIDC_CLIENT_SECRET_FILE=${CANONICAL_OIDC_SECRET_FILE_PATH}\nOIDC_CALLBACK_URL=https://x/api/auth/callback\n`,
    );
  });

  it("guarantee #8: only one active OIDC_CLIENT_SECRET_FILE copy survives when both a stale active line and the commented selector exist", () => {
    const original = [
      "OIDC_CLIENT_SECRET_FILE=/stale",
      "# OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    ].join("\n") + "\n";
    writeFileSync(envPath(), original, { mode: 0o600 });
    updateManagedKeys(deployDir, [["OIDC_CLIENT_SECRET_FILE", CANONICAL_OIDC_SECRET_FILE_PATH]]);
    const matches = readEnv().match(/OIDC_CLIENT_SECRET_FILE=/g) ?? [];
    expect(matches.length).toBe(1);
    expect(readEnv()).toBe(`OIDC_CLIENT_SECRET_FILE=${CANONICAL_OIDC_SECRET_FILE_PATH}\n`);
  });

  it("mode stays restricted to 600 after an atomic rewrite", () => {
    writeFileSync(envPath(), "APP_URL=https://old\n", { mode: 0o600 });
    updateManagedKeys(deployDir, [["APP_URL", "https://new"]]);
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
  });
});

describe("persistOrbitImage", () => {
  beforeEach(() => {
    ensureEnvironmentFile(deployDir);
  });

  it("guarantee #9: is a no-op when no image is given", () => {
    const before = readEnv();
    persistOrbitImage(deployDir, undefined);
    expect(readEnv()).toBe(before);
  });

  it("guarantee #9: refuses a mutable/unpinned image reference", () => {
    expect(() => persistOrbitImage(deployDir, "ghcr.io/tomlawesome/orbit:latest")).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #9: persists a digest-pinned image reference", () => {
    const digestImage = "ghcr.io/tomlawesome/orbit@sha256:" + "a".repeat(64);
    persistOrbitImage(deployDir, digestImage);
    expect(readEnv()).toContain(`ORBIT_IMAGE=${digestImage}`);
  });

  it("guarantee #9: persists an installer-local build tag", () => {
    persistOrbitImage(deployDir, "orbit-local:abcdef123456");
    expect(readEnv()).toContain("ORBIT_IMAGE=orbit-local:abcdef123456");
  });
});

describe("ensureSecretsDirectory", () => {
  it("guarantee #17: creates a fresh, mode-0700 directory", () => {
    ensureSecretsDirectory(deployDir);
    const stat = statSync(join(deployDir, SECRETS_DIRECTORY_NAME));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("guarantee #17: refuses a symlinked .orbit-secrets", () => {
    const realDir = join(deployDir, "elsewhere");
    mkdirSync(realDir);
    symlinkSync(realDir, join(deployDir, SECRETS_DIRECTORY_NAME));
    expect(() => ensureSecretsDirectory(deployDir)).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #17: refuses a non-directory .orbit-secrets", () => {
    writeFileSync(join(deployDir, SECRETS_DIRECTORY_NAME), "not a directory");
    expect(() => ensureSecretsDirectory(deployDir)).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #17: forces an existing directory's permissions to 700", () => {
    mkdirSync(join(deployDir, SECRETS_DIRECTORY_NAME), { mode: 0o755 });
    ensureSecretsDirectory(deployDir);
    expect(statSync(join(deployDir, SECRETS_DIRECTORY_NAME)).mode & 0o777).toBe(0o700);
  });
});

describe("ensureSecretFile", () => {
  beforeEach(() => {
    ensureSecretsDirectory(deployDir);
  });

  it("guarantee #16: generates a mode-0600 64-hex-character secret when absent", () => {
    const result = ensureSecretFile(deployDir, `${SECRETS_DIRECTORY_NAME}/session-secret`);
    expect(result.generated).toBe(true);
    const path = join(deployDir, SECRETS_DIRECTORY_NAME, "session-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it("guarantee #15: preserves an existing valid secret byte-for-byte", () => {
    const path = join(deployDir, SECRETS_DIRECTORY_NAME, "session-secret");
    const value = "b".repeat(64);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    const result = ensureSecretFile(deployDir, `${SECRETS_DIRECTORY_NAME}/session-secret`);
    expect(result.generated).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(`${value}\n`);
  });

  it("guarantee #15: rejects a malformed existing secret", () => {
    const path = join(deployDir, SECRETS_DIRECTORY_NAME, "session-secret");
    writeFileSync(path, "not-hex\n", { mode: 0o600 });
    expect(() => ensureSecretFile(deployDir, `${SECRETS_DIRECTORY_NAME}/session-secret`)).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #15: rejects a symlinked existing secret file", () => {
    const real = join(deployDir, "elsewhere-secret");
    writeFileSync(real, "b".repeat(64) + "\n");
    symlinkSync(real, join(deployDir, SECRETS_DIRECTORY_NAME, "session-secret"));
    expect(() => ensureSecretFile(deployDir, `${SECRETS_DIRECTORY_NAME}/session-secret`)).toThrow(ConfigureEngineRefusal);
  });
});

describe("ensureOidcSecretPlaceholder", () => {
  beforeEach(() => {
    ensureEnvironmentFile(deployDir);
    ensureSecretsDirectory(deployDir);
  });

  it("guarantee #19: creates a zero-byte, mode-0600 placeholder when absent", () => {
    ensureOidcSecretPlaceholder(deployDir);
    const path = join(deployDir, OIDC_SECRET_RELATIVE_PATH);
    expect(statSync(path).size).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("guarantee #18: does not create a placeholder when a direct OIDC_CLIENT_SECRET is already active alone", () => {
    updateManagedKeys(deployDir, [["OIDC_CLIENT_SECRET", "direct-value"]]);
    ensureOidcSecretPlaceholder(deployDir);
    expect(() => statSync(join(deployDir, OIDC_SECRET_RELATIVE_PATH))).toThrow();
  });

  it("guarantee #19: refuses a symlinked placeholder path", () => {
    const real = join(deployDir, "elsewhere");
    writeFileSync(real, "");
    symlinkSync(real, join(deployDir, OIDC_SECRET_RELATIVE_PATH));
    expect(() => ensureOidcSecretPlaceholder(deployDir)).toThrow(ConfigureEngineRefusal);
  });
});

describe("applySetOidcSecret", () => {
  it("guarantee #20-23: writes the secret to the canonical file (mode 0600, no trailing newline) and points .env-orbit at it with an empty direct value", () => {
    ensureEnvironmentFile(deployDir);
    const message = applySetOidcSecret(deployDir, "super-secret-value");
    expect(message).toContain(OIDC_SECRET_RELATIVE_PATH);
    const path = join(deployDir, OIDC_SECRET_RELATIVE_PATH);
    expect(readFileSync(path, "utf8")).toBe("super-secret-value");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readEnv()).toContain("OIDC_CLIENT_SECRET=\n");
    expect(readEnv()).toContain(`OIDC_CLIENT_SECRET_FILE=${CANONICAL_OIDC_SECRET_FILE_PATH}`);
  });

  it("guarantee #22: refuses an empty secret", () => {
    ensureEnvironmentFile(deployDir);
    expect(() => applySetOidcSecret(deployDir, "")).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #22: refuses a secret exceeding the maximum byte size", () => {
    ensureEnvironmentFile(deployDir);
    expect(() => applySetOidcSecret(deployDir, "a".repeat(MAXIMUM_SECRET_BYTES + 1))).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #21: the secret value never appears in the thrown refusal's message for an oversized secret", () => {
    ensureEnvironmentFile(deployDir);
    const secret = "s".repeat(MAXIMUM_SECRET_BYTES + 1);
    try {
      applySetOidcSecret(deployDir, secret);
      expect.fail("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("applyGuidedInit", () => {
  it("guarantee #14: writes nothing when APP_URL is invalid", () => {
    ensureEnvironmentFile(deployDir);
    const before = readEnv();
    expect(() =>
      applyGuidedInit(deployDir, { appUrl: "http://insecure.example", issuer: "https://auth.configure-engine-test.invalid/", clientId: "client" }),
    ).toThrow(ConfigureEngineRefusal);
    expect(readEnv()).toBe(before);
  });

  it("guarantee #13: derives OIDC_CALLBACK_URL from the normalized APP_URL", () => {
    ensureEnvironmentFile(deployDir);
    applyGuidedInit(deployDir, {
      appUrl: "https://Orbit.Example.NET/",
      issuer: "https://auth.configure-engine-test.invalid/application/o/orbit/",
      clientId: "my-client",
    });
    expect(readEnv()).toContain("APP_URL=https://orbit.example.net");
    expect(readEnv()).toContain("OIDC_CALLBACK_URL=https://orbit.example.net/api/auth/callback");
  });

  it("guarantee #11: rejects a loopback APP_URL", () => {
    ensureEnvironmentFile(deployDir);
    expect(() =>
      applyGuidedInit(deployDir, { appUrl: "https://127.0.0.1", issuer: "https://auth.configure-engine-test.invalid/", clientId: "c" }),
    ).toThrow(ConfigureEngineRefusal);
  });
});

describe("setDeploymentProfile", () => {
  beforeEach(() => {
    ensureEnvironmentFile(deployDir);
  });

  it("guarantee #10: standard accepts no model", () => {
    setDeploymentProfile(deployDir, "standard", undefined);
    expect(readEnv()).toContain("COMPOSE_PROFILES=\n");
  });

  it("guarantee #10: standard rejects a given model", () => {
    expect(() => setDeploymentProfile(deployDir, "standard", "some-model")).toThrow(ConfigureEngineRefusal);
  });

  it("guarantee #10: processing sets the profile and Tika URL, no model", () => {
    setDeploymentProfile(deployDir, "processing", undefined);
    expect(readEnv()).toContain("COMPOSE_PROFILES=processing\n");
    expect(readEnv()).toContain("TIKA_URL=http://orbit-tika:9998\n");
  });

  it("guarantee #10: ai requires a valid model", () => {
    expect(() => setDeploymentProfile(deployDir, "ai", undefined)).toThrow(ConfigureEngineRefusal);
    expect(() => setDeploymentProfile(deployDir, "ai", "bad model with spaces")).toThrow(ConfigureEngineRefusal);
    setDeploymentProfile(deployDir, "ai", "llama3:8b");
    expect(readEnv()).toContain("COMPOSE_PROFILES=ai\n");
    expect(readEnv()).toContain("OLLAMA_MODEL=llama3:8b\n");
  });

  it("guarantee #10: full combines both profiles and requires a model", () => {
    setDeploymentProfile(deployDir, "full", "llama3:8b");
    expect(readEnv()).toContain("COMPOSE_PROFILES=processing,ai\n");
    expect(readEnv()).toContain("TIKA_URL=http://orbit-tika:9998\n");
  });

  it("rejects an unknown preset", () => {
    expect(() => setDeploymentProfile(deployDir, "bogus", undefined)).toThrow(ConfigureEngineRefusal);
  });
});

describe("runConfigurePreflight", () => {
  it("guarantee #2: succeeds when .env-orbit does not exist yet", () => {
    expect(runConfigurePreflight(deployDir)).toEqual({ ok: true });
  });

  it("guarantee #2: fails closed on a syntactically invalid .env-orbit", () => {
    writeFileSync(envPath(), "not a valid line\n", { mode: 0o600 });
    expect(runConfigurePreflight(deployDir)).toEqual({ ok: false, code: "preflight-failed" });
  });

  it("guarantee #2: reports configuration-migration-required for a schema-less but otherwise valid file", () => {
    writeFileSync(envPath(), "APP_URL=https://orbit.example.com\n", { mode: 0o600 });
    expect(runConfigurePreflight(deployDir)).toEqual({ ok: false, code: "configuration-migration-required" });
  });

  it("guarantee #2 / configuration.sh #3: fails closed on a loosely-permissioned .env-orbit", () => {
    writeFileSync(envPath(), "ORBIT_CONFIG_SCHEMA_VERSION=1\nAPP_URL=https://orbit.example.com\n", { mode: 0o644 });
    expect(runConfigurePreflight(deployDir)).toEqual({ ok: false, code: "preflight-failed" });
  });

  it("succeeds for a fully current schema-versioned file", () => {
    writeFileSync(envPath(), "ORBIT_CONFIG_SCHEMA_VERSION=1\nAPP_URL=https://orbit.example.com\n", { mode: 0o600 });
    expect(runConfigurePreflight(deployDir)).toEqual({ ok: true });
  });
});

describe("runConfigureApply (bare flow, minus ensure_vapid_keys)", () => {
  it("guarantee #33: is idempotent — a second run preserves already-generated secrets", () => {
    const first = runConfigureApply(deployDir, "orbit-local:abcdef123456");
    expect(first.messages.some((m) => m.includes("Created"))).toBe(true);
    const sessionSecretPath = join(deployDir, SECRETS_DIRECTORY_NAME, "session-secret");
    const generated = readFileSync(sessionSecretPath, "utf8");

    const second = runConfigureApply(deployDir, "orbit-local:abcdef123456");
    expect(second.messages.some((m) => m.includes("Created"))).toBe(false);
    expect(second.messages.some((m) => m.includes("Generated"))).toBe(false);
    expect(readFileSync(sessionSecretPath, "utf8")).toBe(generated);
  });

  it("leaves .env-orbit and .orbit-secrets in place for the (bash-owned) VAPID step and final message to follow", () => {
    runConfigureApply(deployDir, "orbit-local:abcdef123456");
    expect(statSync(envPath()).isFile()).toBe(true);
    expect(statSync(join(deployDir, SECRETS_DIRECTORY_NAME)).isDirectory()).toBe(true);
    // VAPID keys are never touched by this module (see header comment).
    expect(() => statSync(join(deployDir, SECRETS_DIRECTORY_NAME, "vapid-private-key"))).toThrow();
  });

  it("fails closed with configuration-migration-required when preflight finds a schema-less file", () => {
    ensureEnvironmentFile(deployDir);
    writeFileSync(envPath(), "APP_URL=https://orbit.example.com\n", { mode: 0o600 });
    expect(() => runConfigureApply(deployDir, undefined)).toThrow(ConfigureEngineRefusal);
  });
});

describe("machine prompts (v0) — configure.sh field vocabulary", () => {
  function scriptedDriver(answers: string[]): { driver: ConfigureMachinePromptDriver; lines: string[] } {
    const lines: string[] = [];
    const queue = [...answers];
    return {
      lines,
      driver: {
        write: (line) => lines.push(line),
        readLine: () => queue.shift(),
      },
    };
  }

  it("accepts a fully valid guided-init transcript on the first attempt", () => {
    const { driver, lines } = scriptedDriver(["https://orbit.configure-engine-test.invalid", "https://auth.configure-engine-test.invalid/", "my-client"]);
    const result = collectMachineGuidedInit(driver);
    expect(result).toEqual({ appUrl: "https://orbit.configure-engine-test.invalid", issuer: "https://auth.configure-engine-test.invalid/", clientId: "my-client" });
    expect(lines).toEqual([
      "prompt field=APP_URL kind=url required=true attempt=1",
      "prompt-accept field=APP_URL",
      "prompt field=OIDC_ISSUER kind=url required=true attempt=1",
      "prompt-accept field=OIDC_ISSUER",
      "prompt field=OIDC_CLIENT_ID kind=text required=true attempt=1",
      "prompt-accept field=OIDC_CLIENT_ID",
    ]);
  });

  it("rejects, retries, and classifies a loopback APP_URL as forbidden-host before accepting a valid answer", () => {
    const { driver, lines } = scriptedDriver(["https://127.0.0.1", "https://orbit.configure-engine-test.invalid", "https://auth.configure-engine-test.invalid/", "id"]);
    collectMachineGuidedInit(driver);
    expect(lines).toContain("prompt-reject field=APP_URL reason=forbidden-host");
    expect(lines).toContain("prompt field=APP_URL kind=url required=true attempt=2");
  });

  it("aborts after a third rejection, without a fourth prompt", () => {
    const { driver, lines } = scriptedDriver(["not-https", "still-not-https", "nope"]);
    expect(() => collectMachineGuidedInit(driver)).toThrow(ConfigureMachinePromptAbortedError);
    const promptLines = lines.filter((l) => l.startsWith("prompt field="));
    expect(promptLines).toHaveLength(3);
    expect(lines.at(-1)).toBe("prompt-abort field=APP_URL");
  });

  it("aborts on end-of-input without a fourth prompt", () => {
    const { driver, lines } = scriptedDriver([]);
    expect(() => collectMachineGuidedInit(driver)).toThrow(ConfigureMachinePromptAbortedError);
    expect(lines).toEqual(["prompt field=APP_URL kind=url required=true attempt=1", "prompt-abort field=APP_URL"]);
  });

  it("never echoes the OIDC_CLIENT_SECRET answer in any protocol line", () => {
    const secret = "top-secret-value";
    const { driver, lines } = scriptedDriver([secret]);
    const result = collectMachineOidcSecret(driver);
    expect(result).toBe(secret);
    for (const line of lines) {
      expect(line).not.toContain(secret);
    }
  });

  it("classifies an empty OIDC_CLIENT_SECRET answer as empty, and an oversized one as too-large", () => {
    const { driver: driver1, lines: lines1 } = scriptedDriver(["", "x".repeat(MAXIMUM_SECRET_BYTES + 1), "ok"]);
    collectMachineOidcSecret(driver1);
    expect(lines1).toContain("prompt-reject field=OIDC_CLIENT_SECRET reason=empty");
    expect(lines1).toContain(`prompt-reject field=OIDC_CLIENT_SECRET reason=too-large`);
  });
});

describe("internal", () => {
  it("exampleActiveValue requires exactly one active assignment", () => {
    expect(internal.exampleActiveValue("KEY=value\n", "KEY")).toBe("value");
    expect(internal.exampleActiveValue("# KEY=value\n", "KEY")).toBeUndefined();
    expect(internal.exampleActiveValue("KEY=a\nKEY=b\n", "KEY")).toBeUndefined();
  });

  it("isValidLocalModel bounds length and characters", () => {
    expect(internal.isValidLocalModel("llama3:8b")).toBe(true);
    expect(internal.isValidLocalModel("")).toBe(false);
    expect(internal.isValidLocalModel("a".repeat(129))).toBe(false);
    expect(internal.isValidLocalModel("has spaces")).toBe(false);
  });
});

// Confirms generateHexSecret is a real CSPRNG call (node:crypto.randomBytes),
// not a fixture — vi.spyOn used by the parity test file relies on this being
// the one and only source of secret material in this module.
describe("secret generation determinism seam", () => {
  it("produces different secrets across two calls without mocking", () => {
    ensureSecretsDirectory(deployDir);
    const a = ensureSecretFile(deployDir, `${SECRETS_DIRECTORY_NAME}/one`);
    const b = ensureSecretFile(deployDir, `${SECRETS_DIRECTORY_NAME}/two`);
    expect(a.generated && b.generated).toBe(true);
    const valueA = readFileSync(join(deployDir, SECRETS_DIRECTORY_NAME, "one"), "utf8");
    const valueB = readFileSync(join(deployDir, SECRETS_DIRECTORY_NAME, "two"), "utf8");
    expect(valueA).not.toBe(valueB);
  });
});
