import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 P-R13 / P-S25: sign-out deletes the Orbit session first and only then
 * looks up the provider's end-session address. When that lookup failed (the
 * provider blipped, or its discovery document timed out) the route swallowed
 * the error and answered "no provider session", so the browser never visited
 * the provider and the provider's own sign-in survived: the next person to
 * press "Sign back in" was signed in as the previous user.
 *
 * Sign-out therefore needs to fall back on the last good discovery document
 * rather than give up. This pins the discovery side of that: an explicit
 * `staleIfError` option returns the last successfully validated document when
 * a refresh fails, while sign-in (no option) stays strict, and a process that
 * never had a good document still fails.
 *
 * `fetch` is stubbed; the module is re-imported per test so its one-hour
 * discovery cache starts empty.
 */

const ISSUER = "https://idp.example";
const END_SESSION = "https://idp.example/logout";
const config = {
  issuer: ISSUER,
  clientId: "orbit",
  clientSecret: "not-a-real-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid email profile",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
};

function metadataResponse() {
  return new Response(
    JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: "https://idp.example/authorize",
      token_endpoint: "https://idp.example/token",
      jwks_uri: "https://idp.example/jwks",
      end_session_endpoint: END_SESSION,
      code_challenge_methods_supported: ["S256"],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const ONE_HOUR_AND_A_BIT_MS = 3_600_000 + 60_000;

let fetchMock;

async function loadOidc() {
  vi.resetModules();
  return import("../../src/lib/auth/oidc.ts");
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("discoverProvider staleIfError (#1316 P-R13, P-S25)", () => {
  it("returns the last good document when a refresh fails and staleIfError is set", async () => {
    const { discoverProvider } = await loadOidc();
    fetchMock.mockResolvedValueOnce(metadataResponse());
    const first = await discoverProvider(config);
    expect(first.end_session_endpoint).toBe(END_SESSION);

    // The one-hour cache has expired and the provider is now failing.
    vi.advanceTimersByTime(ONE_HOUR_AND_A_BIT_MS);
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

    const stale = await discoverProvider(config, { staleIfError: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stale.end_session_endpoint).toBe(END_SESSION);
  });

  it("stays strict for sign-in: a failed refresh without the option rejects discovery_failed", async () => {
    const { discoverProvider } = await loadOidc();
    fetchMock.mockResolvedValueOnce(metadataResponse());
    await discoverProvider(config);

    vi.advanceTimersByTime(ONE_HOUR_AND_A_BIT_MS);
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(discoverProvider(config)).rejects.toMatchObject({ code: "discovery_failed" });
  });

  it("answers a strict and a staleIfError call started together differently when the shared refresh fails", async () => {
    const { discoverProvider } = await loadOidc();
    fetchMock.mockResolvedValueOnce(metadataResponse());
    await discoverProvider(config);

    vi.advanceTimersByTime(ONE_HOUR_AND_A_BIT_MS);
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

    // Started in the same tick, so both wait on the one refresh in flight.
    const strict = discoverProvider(config);
    const stale = discoverProvider(config, { staleIfError: true });

    await expect(strict).rejects.toMatchObject({ code: "discovery_failed" });
    await expect(stale).resolves.toMatchObject({ end_session_endpoint: END_SESSION });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still rejects discovery_failed with staleIfError when there was never a good document", async () => {
    const { discoverProvider } = await loadOidc();
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));

    await expect(discoverProvider(config, { staleIfError: true })).rejects.toMatchObject({
      code: "discovery_failed",
    });
  });
});
