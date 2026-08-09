import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  databaseConnectionString: vi.fn(() => "postgres://configured"),
  getDb: vi.fn(),
}));

vi.mock("@/db", () => mocks);

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
  ])("rejects partial %s configuration with bounded fields", (_label, changes, field) => {
    let failure: unknown;
    try {
      validateStartupConfiguration({ ...baseEnvironment(), ...changes });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StartupConfigurationError);
    const issues = (failure as StartupConfigurationError).issues;
    expect(issues).toContainEqual(expect.objectContaining({ field, code: "configuration_optional" }));
    expect(JSON.stringify(failure)).not.toContain("example.invalid");
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

  it("rejects enabled push when its private key file is unreadable", () => {
    let failure: unknown;
    try {
      validateStartupConfiguration({
        ...baseEnvironment(),
        VAPID_SUBJECT: "mailto:admin@example.invalid",
        VAPID_PUBLIC_KEY: "configured-public-key",
        VAPID_PRIVATE_KEY_FILE: "/missing/runtime-secret",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StartupConfigurationError);
    expect((failure as StartupConfigurationError).issues).toContainEqual({ field: "push", code: "configuration_optional" });
    expect((failure as StartupConfigurationError).issues).not.toContainEqual(expect.objectContaining({ field: "mail" }));
    expect(JSON.stringify(failure)).not.toContain("configured-public-key");
    expect(JSON.stringify(failure)).not.toContain("missing/runtime-secret");
  });

  it("rejects partially configured default IMAP before database access", () => {
    let failure: unknown;
    try {
      validateStartupConfiguration({ ...baseEnvironment(), IMAP_HOST: "imap.example.invalid" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StartupConfigurationError);
    expect((failure as StartupConfigurationError).issues).toContainEqual({ field: "imap", code: "configuration_optional" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
