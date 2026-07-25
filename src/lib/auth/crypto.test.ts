import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../env";
import { createPkceChallenge, openLoginTransaction, safeReturnPath, sealLoginTransaction } from "./crypto";

const config: AuthConfig = {
  appUrl: new URL("http://127.0.0.1:3000"),
  sessionSecret: "test-secret-that-is-at-least-thirty-two-characters",
  sessionTtlSeconds: 3600,
  issuer: "https://auth.example.test/application/o/orbit/",
  clientId: "orbit",
  clientSecret: "secret",
  callbackUrl: "http://127.0.0.1:3000/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: false,
};

describe("OIDC transaction cryptography", () => {
  it("matches the RFC 7636 S256 example", () => {
    expect(createPkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("round-trips an encrypted short-lived login transaction", async () => {
    const transaction = { state: "state", nonce: "nonce", codeVerifier: "verifier", returnTo: "/settings" };
    const sealed = await sealLoginTransaction(transaction, config);
    const parts = sealed.split(".");
    const middle = Math.floor(parts[3].length / 2);
    const replacement = parts[3][middle] === "a" ? "b" : "a";
    parts[3] = `${parts[3].slice(0, middle)}${replacement}${parts[3].slice(middle + 1)}`;
    const tampered = parts.join(".");
    await expect(openLoginTransaction(sealed, config)).resolves.toEqual(transaction);
    await expect(openLoginTransaction(tampered, config)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("only accepts application-relative return paths", () => {
    expect(safeReturnPath("/households/one")).toBe("/households/one");
    expect(safeReturnPath("//attacker.example")).toBe("/");
    expect(safeReturnPath("https://attacker.example")).toBe("/");
  });
});
