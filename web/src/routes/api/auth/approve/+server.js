import { authErrorResponse } from "orbit/lib/auth/http";
import { assertSameOrigin } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { decideSignInApproval } from "orbit/server/sign-in-approvals";

import { api } from "$lib/server/api.js";

/**
 * The one press that decides a pending sign-in (#1033, ADR-0027 §4).
 *
 * Signed out by design -- the whole point is that the person reading the mail
 * need not be signed in, and is not signed in by answering -- so this takes
 * the bare wrapper and asserts same-origin. The token in the body is the whole
 * authorisation, exactly as the setup route's token is.
 *
 * IT IS A POST, AND THAT IS THE DESIGN. Opening the link approves nothing:
 * mail scanners follow links, and a factor that a scanner could satisfy is not
 * a factor (build ruling, 2026-09-18). The approval page reads the request
 * with a plain load and nothing changes until somebody presses one of its two
 * buttons.
 *
 * One generic answer for an unknown, lapsed, spent or already-decided token:
 * whoever is holding a guess learns nothing from it, the same rule a setup
 * link follows.
 */
export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    /** @type {Record<string, unknown>} */
    let body = {};
    try {
      const parsed = await event.request.json();
      if (parsed && typeof parsed === "object") body = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      // A malformed body is answered by the checks below.
    }
    const token = typeof body.token === "string" ? body.token : "";
    const decision = body.decision === "denied" ? "denied" : "approved";

    const { recorded } = await decideSignInApproval(token, decision);

    return new Response(
      JSON.stringify({ recorded, decision }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  },
  { errorResponse: authErrorResponse },
);
