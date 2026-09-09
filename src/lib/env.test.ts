import { describe, expect, it } from "vitest";
import { getAuthConfig } from "./env";

// ADR-0023 §1 (M7 slice 1): local sign-in is always available; OIDC is
// enabled only by the explicit ORBIT_AUTH_OIDC key. This fixture keeps it
// "true" so every pre-existing case below still exercises OIDC exactly as
// the e2e stack does today.
const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  SESSION_SECRET: "a".repeat(64),
  ORBIT_AUTH_OIDC: "true",
  OIDC_ISSUER: "https://auth.example/application/o/orbit/",
  OIDC_CLIENT_ID: "orbit",
  OIDC_CLIENT_SECRET: "client-secret",
};

const localOnlyEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  SESSION_SECRET: "a".repeat(64),
};

describe("authentication configuration", () => {
  it("allows loopback HTTP for development and derives the callback URL", () => {
    const config = getAuthConfig(validEnvironment);
    expect(config.secureCookies).toBe(false);
    expect(config.oidc?.callbackUrl).toBe("http://127.0.0.1:3000/api/auth/callback");
    expect(config.oidc?.scopes).toBe("openid profile email");
  });

  it("uses secure cookies for an HTTPS deployment", () => {
    const config = getAuthConfig({ ...validEnvironment, APP_URL: "https://orbit.example" });
    expect(config.secureCookies).toBe(true);
  });

  it.each([
    [{ ...validEnvironment, APP_URL: "http://orbit.example" }, "APP_URL"],
    [{ ...validEnvironment, OIDC_ISSUER: "http://auth.example/application/o/orbit/" }, "OIDC_ISSUER"],
    [{ ...validEnvironment, OIDC_SCOPES: "profile email" }, "openid"],
    [{ ...validEnvironment, SESSION_SECRET: "too-short" }, "SESSION_SECRET"],
    // Long enough for the old `min(32)` rule, but not the 256-bit hexadecimal
    // secret configure.sh generates and demands (issue #578).
    [{ ...validEnvironment, SESSION_SECRET: "z".repeat(64) }, "SESSION_SECRET"],
  ])("rejects unsafe or incomplete configuration", (environment, message) => {
    expect(() => getAuthConfig(environment)).toThrow(message);
  });

  it("is local-only (oidc: null) when ORBIT_AUTH_OIDC is unset, with no OIDC fields required", () => {
    const config = getAuthConfig(localOnlyEnvironment);
    expect(config.oidc).toBeNull();
  });

  it("ignores a full provider block left in place while ORBIT_AUTH_OIDC=false, rather than validating it", () => {
    const config = getAuthConfig({
      ...localOnlyEnvironment,
      ORBIT_AUTH_OIDC: "false",
      // An invalid issuer would fail validation if OIDC were enabled; here
      // it must simply be ignored (ADR-0023 §1: switching a provider off
      // must not force deleting its configuration).
      OIDC_ISSUER: "not-a-valid-issuer-url",
      OIDC_CLIENT_ID: "orbit",
      OIDC_CLIENT_SECRET: "client-secret",
    });
    expect(config.oidc).toBeNull();
  });

  it("fails readiness by field name when ORBIT_AUTH_OIDC=true and OIDC_ISSUER is blank", () => {
    expect(() => getAuthConfig({
      ...localOnlyEnvironment,
      ORBIT_AUTH_OIDC: "true",
      OIDC_ISSUER: "",
      OIDC_CLIENT_ID: "orbit",
      OIDC_CLIENT_SECRET: "client-secret",
    })).toThrow("OIDC_ISSUER");
  });
});
