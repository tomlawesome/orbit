import {
  hasActiveClaim,
  isClaimed,
  sealClaimProof,
  setClaimCookie,
  verifyClaim,
} from "orbit/lib/auth/bootstrap";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { assertSameOrigin } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

import { api } from "$lib/server/api.js";

/**
 * Claims the instance with the code printed at start-up (ADR-0022 §2).
 *
 * Signed out by design — nobody has an account yet — so it takes the bare
 * wrapper rather than `write()`, which would demand a session and a CSRF
 * token derived from one. Same-origin is still asserted: this is a write in
 * every sense that matters, and the cookie it mints is what the next two
 * requests spend.
 *
 * Every failure is the one generic `bootstrap_invalid`, whatever went wrong,
 * so a caller learns only whether they had the code. Success mints
 * `__Secure-orbit-claim` and carries no secret in the body — the code never
 * leaves the process that printed it.
 */
export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    /* State decides, not the cookie: once the instance is claimed this route
       says so to everyone, which is also what a losing racer is told. */
    if (await isClaimed()) {
      throw new AuthError("bootstrap_claimed", "This Orbit instance has already been claimed", 409);
    }
    if (!hasActiveClaim()) {
      throw new AuthError(
        "bootstrap_unavailable",
        "This instance has no claim code; restart it and read the notice in its log",
        503,
      );
    }

    let claim = "";
    try {
      const body = await event.request.json();
      if (body && typeof body === "object" && typeof (/** @type {{ claim?: unknown }} */ (body).claim) === "string") {
        claim = /** @type {{ claim: string }} */ (body).claim;
      }
    } catch {
      // A malformed body is a wrong code, answered exactly like one.
    }

    const verdict = await verifyClaim(claim);
    if (!verdict.accepted) {
      throw new AuthError("bootstrap_invalid", "That claim code is not valid", 403);
    }

    setClaimCookie(event.cookies, await sealClaimProof(config), config);
    return new Response(
      JSON.stringify({ claimed: false, methods: { local: true, oidc: config.oidc !== null } }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  },
  { errorResponse: authErrorResponse },
);
