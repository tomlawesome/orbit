import {
  clearPendingSignInCookie,
  pendingSignInCookieName,
  sessionCookieName,
  setSessionCookie,
} from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { issuePasswordChangeHold } from "orbit/lib/auth/password-change-hold";
import { assertSameOrigin, createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { collectSignInApproval } from "orbit/server/sign-in-approvals";

import { api } from "$lib/server/api.js";

/**
 * Where a waiting tab asks whether its sign-in has been approved yet, and the
 * one place a session is minted for it (#1033, ADR-0027 §4).
 *
 * Signed out by design, like the sign-in route it follows, so it takes the
 * bare wrapper and asserts same-origin: there is no session yet for a CSRF
 * token to be derived from. A POST rather than a GET because it is a write --
 * an approved pending sign-in is SPENT here, once.
 *
 * THE CLAIM IS THE WHOLE OF THE AUTHORISATION, and it is in an HTTP-only
 * cookie this browser was handed when it typed the password. Nothing in the
 * request body is read at all. That is what the build ruling of 2026-09-18
 * asks for: only the browser that typed the password can collect the session,
 * so somebody who watched the approval happen -- or who approved it
 * themselves, from the forwarded link -- polls this route and gets nothing.
 *
 * Four answers, and only the first of them changes anything:
 *
 *   `approved` — somebody pressed Approve; the session is created here and
 *     the cookie set, exactly as the password route used to do it.
 *   `password_change_required` — approved, but a refused sign-in has marked
 *     this password (#1881). No session: the tab gets the change-password
 *     hold, which lapses with this approval, and the moment of the newest
 *     refusal for the card's one sentence. A poll whose answer was lost
 *     gets the same hold again from the spent approval, lapsing when the
 *     first one did (#1901).
 *   `waiting`  — nobody has pressed anything. The tab asks again.
 *   `denied`   — somebody pressed "This wasn't me". The tab says so and stops.
 *   `unknown`  — no pending sign-in, or it has lapsed or been spent. One word
 *     for all three, for the same reason a setup link has one word for its
 *     three.
 */
export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    const claim = event.cookies.get(pendingSignInCookieName(config)) ?? "";
    /* Session creation is the spend's own mint callback (#1151 SR1-R7), not a
       separate call made after: collectSignInApproval reverts the spend when
       this throws, so a crash or a transient failure here no longer strands
       a correctly approved sign-in with the claim already burned and nothing
       left to retry. */
    let pending;
    try {
      pending = await collectSignInApproval(
        claim,
        (userId, recordMint) => createSession(
          userId,
          config,
          event.request.headers.get("user-agent"),
          /* The spend's record that it minted this session commits with the
             session itself (#1943 SEC-H1). */
          { alsoInTransaction: recordMint },
        ),
      );
    } catch (error) {
      /* The account was disabled between the approval and this insert. The
         sign-in route answers that race generically and so does this one. */
      if (error instanceof AuthError && error.code === "account_disabled") {
        return answer({ state: "unknown" });
      }
      throw error;
    }

    if (pending.state === "approved") {
      clearPendingSignInCookie(event.cookies, config);
      await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
      setSessionCookie(event.cookies, /** @type {{token: string}} */ (pending.session).token, config);
      return answer({ state: "approved", authenticated: true });
    }

    if (pending.state === "password_change_required") {
      clearPendingSignInCookie(event.cookies, config);
      const hold = await issuePasswordChangeHold(event.cookies, pending.refusal, config, pending.lapsesAt);
      return answer({ state: "password_change_required", refusedAt: hold.refusedAt });
    }

    if (pending.state === "denied" || pending.state === "unknown") {
      clearPendingSignInCookie(event.cookies, config);
    }
    return answer({ state: pending.state });
  },
  { errorResponse: authErrorResponse },
);

/** @param {Record<string, unknown>} body */
function answer(body) {
  return new Response(
    JSON.stringify(body),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
