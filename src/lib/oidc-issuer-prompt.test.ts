import { describe, expect, it, vi } from "vitest";

import { OIDC_DISCOVERY_MAX_BYTES, checkOidcIssuerAgainstDiscovery } from "./oidc-discovery";

// #1454: the OIDC issuer answer is checked against the provider's discovery
// document at the prompt, so a trailing-slash mismatch (Authentik publishes
// an issuer ending in "/", Keycloak one without) is caught there and not
// after every other question has been answered. Written from the issue
// before the code exists.
//
// SEAM ASSUMED (the builder can honour it or report a mismatch):
//
//   // src/lib/oidc-discovery.ts, next to verifyOidcDiscovery
//   export type OidcIssuerPromptReason = "trailing-slash-mismatch" | "provider-unreachable" | /* any other */ string;
//   export type OidcIssuerPromptOutcome =
//     | { status: "ok" }
//     | { status: "rejected"; reason: OidcIssuerPromptReason; message: string };
//   export async function checkOidcIssuerAgainstDiscovery(
//     issuerAnswer: string,
//     options?: VerifyOidcDiscoveryOptions, // the same { fetchImpl?, timeoutMs? } verifyOidcDiscovery takes
//   ): Promise<OidcIssuerPromptOutcome>;
//
// It runs isValidOidcIssuer first (badly shaped answers are rejected with no
// request), then fetches buildDiscoveryUrl(answer) under the limits
// verifyOidcDiscovery already enforces (https only, timeoutMs, byte cap).
// `message` is the text the prompt shows; for a slash-only difference it
// contains the provider's issuer exactly as published. Wiring the outcome
// into the machine-prompt protocol (validateOidcIssuerAnswer in
// configure-engine.ts, docs/engine-events.md) is not covered here.

const WITHOUT_SLASH = "https://idp.example.invalid/realms/x";
const WITH_SLASH = "https://idp.example.invalid/realms/x/";

function discoveryDocument(issuer: string): string {
  return JSON.stringify({
    issuer,
    authorization_endpoint: "https://idp.example.invalid/authorize",
    token_endpoint: "https://idp.example.invalid/token",
    jwks_uri: "https://idp.example.invalid/jwks",
  });
}

function providerPublishing(issuer: string) {
  return vi.fn<typeof fetch>(
    async () => new Response(discoveryDocument(issuer), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

describe("checkOidcIssuerAgainstDiscovery (#1454)", () => {
  it("rejects an answer with a trailing slash when the provider publishes none, naming the provider's issuer", async () => {
    const fetchImpl = providerPublishing(WITHOUT_SLASH);
    const outcome = await checkOidcIssuerAgainstDiscovery(WITH_SLASH, { fetchImpl });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toBe("trailing-slash-mismatch");
    expect(outcome.message).toContain(WITHOUT_SLASH);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://idp.example.invalid/realms/x/.well-known/openid-configuration");
  });

  it("rejects an answer missing the trailing slash when the provider publishes one, naming the provider's issuer", async () => {
    const fetchImpl = providerPublishing(WITH_SLASH);
    const outcome = await checkOidcIssuerAgainstDiscovery(WITHOUT_SLASH, { fetchImpl });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toBe("trailing-slash-mismatch");
    expect(outcome.message).toContain(WITH_SLASH);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://idp.example.invalid/realms/x/.well-known/openid-configuration");
  });

  it.each([
    ["with a trailing slash", WITH_SLASH],
    ["without a trailing slash", WITHOUT_SLASH],
  ])("accepts an answer that matches the provider's published issuer exactly, %s", async (_label, issuer) => {
    const outcome = await checkOidcIssuerAgainstDiscovery(issuer, { fetchImpl: providerPublishing(issuer) });
    expect(outcome).toEqual({ status: "ok" });
  });

  it("gives an unreachable provider its own reason, without a slash hint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const outcome = await checkOidcIssuerAgainstDiscovery(WITH_SLASH, { fetchImpl });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toBe("provider-unreachable");
    expect(outcome.reason).not.toBe("trailing-slash-mismatch");
    expect(outcome.message).not.toMatch(/slash/i);
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it("treats a provider that does not answer within timeoutMs as unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
        }),
    );
    const outcome = await checkOidcIssuerAgainstDiscovery(WITH_SLASH, { fetchImpl, timeoutMs: 25 });
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toBe("provider-unreachable");
    expect(outcome.message).not.toMatch(/slash/i);
  });

  it("does not accept a mismatch that is more than a trailing slash, and gives no slash hint", async () => {
    const fetchImpl = providerPublishing("https://idp.example.invalid/realms/other/");
    const outcome = await checkOidcIssuerAgainstDiscovery(WITHOUT_SLASH, { fetchImpl });
    expect(outcome.status).not.toBe("ok");
    if (outcome.status === "rejected") {
      expect(outcome.reason).not.toBe("trailing-slash-mismatch");
      expect(outcome.reason).not.toBe("provider-unreachable");
    }
  });

  it("does not accept a discovery document larger than the byte cap", async () => {
    const oversize = JSON.stringify({ issuer: WITH_SLASH, padding: "a".repeat(OIDC_DISCOVERY_MAX_BYTES) });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(oversize, { status: 200 }));
    const outcome = await checkOidcIssuerAgainstDiscovery(WITH_SLASH, { fetchImpl });
    expect(outcome.status).not.toBe("ok");
  });

  it.each([
    ["plain http", "http://idp.example.invalid/realms/x"],
    ["credentials in the authority", "https://user:pw@idp.example.invalid/realms/x"],
    ["a query string", "https://idp.example.invalid/realms/x?a=b"],
    ["a loopback address", "https://127.0.0.1/realms/x"],
    ["not a URL at all", "not a url"],
    ["empty", ""],
  ])("refuses a badly shaped answer (%s) before any request", async (_label, answer) => {
    const fetchImpl = providerPublishing(WITH_SLASH);
    const outcome = await checkOidcIssuerAgainstDiscovery(answer, { fetchImpl });
    expect(outcome.status).toBe("rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
