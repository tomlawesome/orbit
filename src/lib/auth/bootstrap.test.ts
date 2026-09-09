import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../env";
import {
  CLAIM_COOKIE_TTL_SECONDS,
  claimCookieName,
  clearClaimCookie,
  formatClaimNotice,
  generateClaim,
  hasActiveClaim,
  hasClaimProof,
  normaliseClaim,
  sealClaimProof,
  setActiveClaimForTests,
  setBootstrapClockForTests,
  setClaimCookie,
  verifyClaim,
} from "./bootstrap";
import { sealProof } from "./crypto";

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example.org"),
  sessionSecret: "test-secret-that-is-at-least-thirty-two-characters",
  sessionTtlSeconds: 3600,
  secureCookies: true,
  oidc: null,
};

/** The cookie jar a route writes into, reduced to what these assertions read. */
function jar() {
  const written = new Map<string, { value: string; options: Record<string, unknown> }>();
  return {
    written,
    cookies: {
      get: (name: string) => written.get(name)?.value,
      set: (name: string, value: string, options: Record<string, unknown>) => {
        written.set(name, { value, options });
      },
    },
  };
}

afterEach(() => {
  setActiveClaimForTests(undefined);
  setBootstrapClockForTests(undefined);
});

describe("the claim code", () => {
  it("is 32 bytes of base32 in groups of four", () => {
    const claim = generateClaim();
    // 256 bits at 5 bits a character: 52 characters, the last one padded.
    expect(claim.normalised).toHaveLength(52);
    expect(claim.normalised).toMatch(/^[A-Z2-7]{52}$/);
    expect(claim.display).toBe(claim.normalised.match(/.{1,4}/gu)!.join("-"));
    expect(generateClaim().normalised).not.toBe(claim.normalised);
  });

  it("ignores case, spacing and hyphens on entry", () => {
    expect(normaliseClaim(" abcd-efgh ijkl ")).toBe("ABCDEFGHIJKL");
  });
});

describe("the notice printed at start-up", () => {
  const claim = { normalised: "ABCDEFGH", display: "ABCD-EFGH" };

  it("names the link and the bare code, in that order", () => {
    expect(formatClaimNotice(claim, config, "text")).toBe(
      [
        "Orbit is not yet claimed. Open this link to create the first administrator:",
        "  https://orbit.example.org/#claim=ABCD-EFGH",
        "or enter the code by hand on the sign-in screen: ABCD-EFGH",
      ].join("\n"),
    );
  });

  it("carries the code in the fragment, never in a query string", () => {
    const link = new URL(formatClaimNotice(claim, config, "text").split("\n")[1].trim());
    expect(link.hash).toBe("#claim=ABCD-EFGH");
    expect(link.search).toBe("");
  });

  it("is one JSON object under ORBIT_LOG_FORMAT=json", () => {
    expect(JSON.parse(formatClaimNotice(claim, config, "json"))).toEqual({
      event: "bootstrap.claim",
      url: "https://orbit.example.org/#claim=ABCD-EFGH",
      code: "ABCD-EFGH",
    });
  });
});

describe("verifying an entered code", () => {
  it("refuses everything when this process holds no code", async () => {
    expect(hasActiveClaim()).toBe(false);
    expect(await verifyClaim("ABCD-EFGH")).toEqual({ accepted: false, refusal: "unavailable" });
  });

  it("accepts the code however it was typed, and refuses anything else", async () => {
    const claim = generateClaim();
    setActiveClaimForTests(claim);
    expect(await verifyClaim(claim.display.toLowerCase())).toEqual({ accepted: true });
    expect(await verifyClaim(claim.normalised)).toEqual({ accepted: true });
    expect(await verifyClaim(`${claim.normalised.slice(0, -1)}X`)).toEqual({ accepted: false, refusal: "mismatch" });
    expect(await verifyClaim("")).toEqual({ accepted: false, refusal: "mismatch" });
  });

  it("locks a guesser out after five free attempts and lets the correct code through again once the penalty lapses", async () => {
    const claim = generateClaim();
    setActiveClaimForTests(claim);
    let now = 1_000_000;
    setBootstrapClockForTests(() => now);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await verifyClaim("WRONG")).toEqual({ accepted: false, refusal: "mismatch" });
    }
    // The sixth is still compared; it is the seventh that meets the penalty.
    expect(await verifyClaim("WRONG")).toEqual({ accepted: false, refusal: "mismatch" });
    expect(await verifyClaim(claim.display)).toEqual({ accepted: false, refusal: "throttled" });

    now += 1_001;
    expect(await verifyClaim(claim.display)).toEqual({ accepted: true });
  });
});

describe("the claim cookie", () => {
  it("is host-scoped, http-only and lives five minutes", async () => {
    const sink = jar();
    setClaimCookie(sink.cookies, await sealClaimProof(config), config);
    const cookie = sink.written.get("__Secure-orbit-claim");
    expect(cookie?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 300,
    });
    expect(CLAIM_COOKIE_TTL_SECONDS).toBe(300);
    expect(claimCookieName({ ...config, secureCookies: false })).toBe("orbit-claim");
  });

  it("opens only for the audience it was sealed with", async () => {
    const sink = jar();
    setClaimCookie(sink.cookies, await sealClaimProof(config), config);
    expect(await hasClaimProof(sink.cookies, config)).toBe(true);

    setClaimCookie(sink.cookies, await sealProof({ claim: true }, "oidc-login-transaction", 300, config), config);
    expect(await hasClaimProof(sink.cookies, config)).toBe(false);
  });

  it("refuses a missing, forged or five-minute-old cookie", async () => {
    const sink = jar();
    expect(await hasClaimProof(sink.cookies, config)).toBe(false);

    setClaimCookie(sink.cookies, "not-a-sealed-proof", config);
    expect(await hasClaimProof(sink.cookies, config)).toBe(false);

    /* A real cookie, aged past its five minutes. Only `Date` is faked, so
       nothing here waits on a timer that will never fire; `jose` allows five
       seconds of clock skew, which is why the jump clears it. */
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const proof = await sealClaimProof(config);
      setClaimCookie(sink.cookies, proof, config);
      expect(await hasClaimProof(sink.cookies, config)).toBe(true);
      vi.setSystemTime(Date.now() + (CLAIM_COOKIE_TTL_SECONDS + 6) * 1_000);
      expect(await hasClaimProof(sink.cookies, config)).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    clearClaimCookie(sink.cookies, config);
    expect(sink.written.get("__Secure-orbit-claim")?.options).toMatchObject({ maxAge: 0 });
    expect(await hasClaimProof(sink.cookies, config)).toBe(false);
  });
});
