import {
  clearPendingSignInCookie,
  pendingSignInCookieName,
  sessionCookieName,
  setSessionCookie,
} from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
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
    const pending = await collectSignInApproval(claim);

    if (pending.state === "approved") {
      clearPendingSignInCookie(event.cookies, config);
      await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
      let session;
      try {
        session = await createSession(pending.userId, config, event.request.headers.get("user-agent"));
      } catch (error) {
        /* The account was disabled between the approval and this insert. The
           sign-in route answers that race generically and so does this one. */
        if (error instanceof AuthError && error.code === "account_disabled") {
          return answer({ state: "unknown" });
        }
        throw error;
      }
      setSessionCookie(event.cookies, session.token, config);
      return answer({ state: "approved", authenticated: true });
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
