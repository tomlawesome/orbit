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
  SESSION_SECRET: "s".repeat(32),
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
    ["imap", { IMAP_HOST: "imap.example.invalid" }, "imap"],
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

  it("accepts preconfigured disabled IMAP and dormant VAPID key material without a push subject", () => {
    expect(() => validateStartupConfiguration({
      ...baseEnvironment(),
      IMAP_ENABLED: "false",
      IMAP_HOST: "imap.example.invalid",
      IMAP_USER: "orbit-test-user",
      IMAP_PASSWORD: "test-only-imap-password",
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

  it("records partially configured default IMAP without opening the database", () => {
    expect(() => validateStartupConfiguration({ ...baseEnvironment(), IMAP_HOST: "imap.example.invalid" })).not.toThrow();
    expect(getConfigurationProblems()).toContainEqual(expect.objectContaining({
      setting: "imap",
      code: "configuration_optional",
      severity: "warning",
      fallback: "feature_disabled",
    }));
    expect(mocks.getDb).not.toHaveBeenCalled();
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
});
