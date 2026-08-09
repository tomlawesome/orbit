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
  ORBIT_IMAGE: "orbit-local:abcdef123456",
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
    ["image", { ORBIT_IMAGE: "" }, "ORBIT_IMAGE"],
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
});
