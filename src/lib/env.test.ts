import { describe, expect, it } from "vitest";
import { getAuthConfig } from "./env";

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  APP_URL: "http://127.0.0.1:3000",
  SESSION_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
  OIDC_ISSUER: "https://auth.example/application/o/orbit/",
  OIDC_CLIENT_ID: "orbit",
  OIDC_CLIENT_SECRET: "client-secret",
};

describe("authentication configuration", () => {
  it("allows loopback HTTP for development and derives the callback URL", () => {
    const config = getAuthConfig(validEnvironment);
    expect(config.secureCookies).toBe(false);
    expect(config.callbackUrl).toBe("http://127.0.0.1:3000/api/auth/callback");
    expect(config.scopes).toBe("openid profile email");
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
  ])("rejects unsafe or incomplete configuration", (environment, message) => {
    expect(() => getAuthConfig(environment)).toThrow(message);
  });
});
