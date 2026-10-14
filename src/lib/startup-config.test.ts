import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  databaseConnectionString: vi.fn(() => "postgres://configured"),
  getDb: vi.fn(),
}));

vi.mock("@/db", () => mocks);

import { getConfigurationProblems, resetConfigurationProblemsForTests } from "./configuration-problems";
import { StartupConfigurationError, validateStartupConfiguration } from "./startup-config";

const baseEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  ORBIT_CONFIG_SCHEMA_VERSION: "1",
  APP_URL: "https://orbit.example.invalid",
  SESSION_SECRET: "b".repeat(64),
  OIDC_ISSUER: "https://identity.example.invalid/issuer",
  OIDC_CLIENT_ID: "client-id",
  OIDC_CLIENT_SECRET: "client-secret",
  OIDC_CALLBACK_URL: "https://orbit.example.invalid/api/auth/callback",
  DOCUMENT_KEK: "a".repeat(64),
  POSTGRES_PASSWORD: "database-password",
});

describe("startup configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConfigurationProblemsForTests();
  });

  it("accepts valid core configuration without opening the database", () => {
    expect(() => validateStartupConfiguration(baseEnvironment())).not.toThrow();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["processing", { COMPOSE_PROFILES: "processing" }, "processing"],
    ["ai", { COMPOSE_PROFILES: "ai" }, "ai"],
    ["mail", { SMTP_HOST: "smtp.example.invalid" }, "mail"],
    ["push", { VAPID_SUBJECT: "mailto:admin@example.invalid" }, "push"],
  ])("tolerates partial %s configuration and records a bounded disabled fallback", (_label, changes, field) => {
    expect(() => validateStartupConfiguration({ ...baseEnvironment(), ...changes })).not.toThrow();
    expect(getConfigurationProblems()).toContainEqual(expect.objectContaining({
      setting: field,
      code: "configuration_optional",
      severity: "warning",
      fallback: "feature_disabled",
    }));
    expect(JSON.stringify(getConfigurationProblems())).not.toContain("example.invalid");
  });

  it.each([
    ["version", { ORBIT_CONFIG_SCHEMA_VERSION: "2" }, "ORBIT_CONFIG_SCHEMA_VERSION"],
    ["missing secret file", { SESSION_SECRET: undefined, SESSION_SECRET_FILE: "/missing/runtime-secret" }, "authentication"],
  ])("rejects invalid core %s before database access", (_label, changes, field) => {
    let failure: unknown;
    try {
      validateStartupConfiguration({ ...baseEnvironment(), ...changes });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StartupConfigurationError);
    expect((failure as StartupConfigurationError).issues).toContainEqual(expect.objectContaining({ field }));
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("names the failing rule and its remedy for an invalid session secret, never the secret itself (#717)", () => {
    const badSecret = "not-a-valid-hex-session-secret";
    let failure: unknown;
    try {
      validateStartupConfiguration({ ...baseEnvironment(), SESSION_SECRET: badSecret });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StartupConfigurationError);
    const issue = (failure as StartupConfigurationError).issues.find((entry) => entry.field === "authentication");
    /*
     * Grepping the log for the validator's own wording used to return zero
     * matches (#717) because only the coded `field`/`code` reached it. This
     * asserts the actual remedy text -- not just that some string exists.
     */
    expect(issue?.detail).toContain("64 hexadecimal characters");
    expect(issue?.detail).toContain("openssl rand -hex 32");
    expect(issue?.detail).not.toContain(badSecret);
  });

  /*
   * The fixture harness must not be switchable on in a production Orbit
   * (#773). Until the cut it took two mistakes: nothing production ran set
   * ORBIT_FIXTURES, and the composite entry kept /api on the engine whatever
   * the SvelteKit app thought. The cut deleted the second layer, so this is
   * the replacement for it — and since #789 the same flag also bypasses the
   * authentication gate, which makes it load-bearing in two places.
   */
  it.each([
    ["on", "1"],
    ["off but present", "0"],
    ["unparseable", "yes-please"],
    ["empty-ish whitespace", " "],
  ])("refuses to start a production build with the fixture harness %s", (_label, value) => {
    let failure: unknown;
    try {
      validateStartupConfiguration({ ...baseEnvironment(), NODE_ENV: "production", ORBIT_FIXTURES: value });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StartupConfigurationError);
    expect((failure as StartupConfigurationError).issues).toContainEqual(
      expect.objectContaining({ field: "fixtures", code: "configuration_core" }),
    );
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("starts a production build when the fixture harness is absent", () => {
    expect(() => validateStartupConfiguration({ ...baseEnvironment(), NODE_ENV: "production" })).not.toThrow();
    expect(getConfigurationProblems()).not.toContainEqual(expect.objectContaining({ setting: "fixtures" }));
  });

  it("leaves the fixture harness alone outside a production build", () => {
    // The fidelity gate and `vite dev` both depend on this staying true; it is
    // criterion 2 of #773 and the reason the check is on NODE_ENV rather than
    // on the flag alone.
    expect(() => validateStartupConfiguration({ ...baseEnvironment(), ORBIT_FIXTURES: "1" })).not.toThrow();
  });

  it("accepts dormant VAPID key material without a push subject", () => {
    expect(() => validateStartupConfiguration({
      ...baseEnvironment(),
      VAPID_PUBLIC_KEY: "dormant-public-key",
      VAPID_PRIVATE_KEY_FILE: "/missing/runtime-secret",
    })).not.toThrow();
  });

  it("records an enabled push problem while leaving the application bootable", () => {
    expect(() => validateStartupConfiguration({
      ...baseEnvironment(),
      VAPID_SUBJECT: "mailto:admin@example.invalid",
      VAPID_PUBLIC_KEY: "configured-public-key",
      VAPID_PRIVATE_KEY_FILE: "/missing/runtime-secret",
    })).not.toThrow();
    expect(getConfigurationProblems()).toContainEqual(expect.objectContaining({
      setting: "push",
      code: "configuration_optional",
      severity: "warning",
      fallback: "feature_disabled",
    }));
    expect(JSON.stringify(getConfigurationProblems())).not.toContain("configured-public-key");
    expect(JSON.stringify(getConfigurationProblems())).not.toContain("missing/runtime-secret");
  });

  it("uses safe logging defaults while exposing invalid logging configuration", () => {
    expect(() => validateStartupConfiguration({
      ...baseEnvironment(),
      ORBIT_LOG_LEVEL: "verbose",
      ORBIT_LOG_FORMAT: "yaml",
    })).not.toThrow();
    expect(getConfigurationProblems()).toContainEqual(expect.objectContaining({
      setting: "logging",
      code: "configuration_optional",
      severity: "warning",
      fallback: "feature_disabled",
    }));
  });

  /*
   * #1405: a missing or unusable document key no longer stops the container.
   * It is reported as its own, non-blocking, kind of problem
   * (`configuration_key` on the `documents` setting) and the process comes up
   * so it can say so to members (the maintenance screen) and to the operator
   * (the log and the alert). The rest of the document settings are still
   * checked, so a missing key cannot hide a bad DOCUMENTS_ROOT.
   */
  describe("the document key (#1405)", () => {
    const keyProblems = () => getConfigurationProblems().filter((problem) => problem.code === ("configuration_key" as never));

    it("reports a missing key as one non-blocking problem and starts", () => {
      const environment = { ...baseEnvironment(), DOCUMENT_KEK: undefined };
      expect(() => validateStartupConfiguration(environment)).not.toThrow();
      expect(keyProblems()).toHaveLength(1);
      expect(keyProblems()[0]).toMatchObject({ setting: "documents", code: "configuration_key" });
      expect(getConfigurationProblems().filter((problem) => problem.setting === "documents")).toHaveLength(1);
    });

    it("still fails to start for a bad core document setting, alongside the key problem", () => {
      const environment = {
        ...baseEnvironment(),
        DOCUMENT_KEK: undefined,
        DOCUMENTS_ROOT: "/var/lib/orbit/same",
        DOCUMENTS_QUARANTINE_ROOT: "/var/lib/orbit/same",
      };
      let failure: unknown;
      try {
        validateStartupConfiguration(environment);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(StartupConfigurationError);
      const issues = (failure as StartupConfigurationError).issues;
      expect(issues).toContainEqual(expect.objectContaining({ field: "documents", code: "configuration_key" }));
      expect(issues).toContainEqual(expect.objectContaining({ field: "documents", code: "configuration_core" }));
    });

    it("keeps the bad core document setting fatal when the key itself is fine", () => {
      expect(() => validateStartupConfiguration({
        ...baseEnvironment(),
        DOCUMENTS_ROOT: "/var/lib/orbit/same",
        DOCUMENTS_QUARANTINE_ROOT: "/var/lib/orbit/same",
      })).toThrow(StartupConfigurationError);
    });

    it.each([
      ["a malformed key", { DOCUMENT_KEK: "not-a-key" }],
      ["a key file that is not there", { DOCUMENT_KEK: undefined, DOCUMENT_KEK_FILE: "/missing/runtime-secret" }],
      ["a key set both directly and by file", { DOCUMENT_KEK_FILE: "/missing/runtime-secret" }],
      ["a next key equal to the current key", { DOCUMENT_KEK_NEXT: "a".repeat(64) }],
    ])("reports %s as a key problem without stopping the start", (_label, changes) => {
      expect(() => validateStartupConfiguration({ ...baseEnvironment(), ...changes })).not.toThrow();
      expect(keyProblems()).toHaveLength(1);
      expect(keyProblems()[0]).toMatchObject({ setting: "documents" });
    });

    it("reports a key problem without the key, the file path or the file's contents", () => {
      validateStartupConfiguration({ ...baseEnvironment(), DOCUMENT_KEK: "b".repeat(63) });
      validateStartupConfiguration({ ...baseEnvironment(), DOCUMENT_KEK: undefined, DOCUMENT_KEK_FILE: "/missing/runtime-secret" });
      const recorded = JSON.stringify(getConfigurationProblems());
      expect(recorded).not.toContain("b".repeat(63));
      expect(recorded).not.toContain("missing/runtime-secret");
    });

    it("reports nothing about the key when it is usable", () => {
      validateStartupConfiguration(baseEnvironment());
      expect(keyProblems()).toEqual([]);
    });
  });
});
