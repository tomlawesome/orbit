import { pendingSignInCookieName } from "orbit/lib/auth/cookies";
import { authErrorResponse } from "orbit/lib/auth/http";
import { assertSameOrigin } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { resendSignInApproval } from "orbit/server/sign-in-approvals";

import { api } from "$lib/server/api.js";

/**
 * The waiting card's "send it again" (#1033, ADR-0027 §8).
 *
 * Signed out and claim-authorised exactly like `login/pending`: the cookie
 * this browser was handed says which pending sign-in it may ask about, and
 * nothing in the body is read. Anyone without that cookie can no more ask for
 * a mail to be re-sent than they can collect the session.
 *
 * The limits are ADR-0027 §8's and live in the engine, not here: one live link
 * per pending sign-in (so this replaces the link rather than adding a second),
 * a minute between sends, and five sends per account per hour. `limited` is
 * the last of those, and the card's own words for it are to read the mail
 * already sent.
 */
export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    const claim = event.cookies.get(pendingSignInCookieName(config)) ?? "";
    const outcome = await resendSignInApproval(claim);

    /* Bounded, and the same shape for every outcome: when another send is
       allowed, and which of the four states this one was. The provider's own
       failure never reaches a signed-out caller. */
    return new Response(
      JSON.stringify({
        state: outcome.state,
        ...(outcome.state === "sent" || outcome.state === "too_soon"
          ? { canResendAt: outcome.canResendAt.toISOString() }
          : {}),
      }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  },
  { errorResponse: authErrorResponse },
);
