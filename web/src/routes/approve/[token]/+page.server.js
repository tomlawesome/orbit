import { readSignInApproval } from "orbit/server/sign-in-approvals";
import { formatApprovalMoment } from "orbit/server/sign-in-approvals/mail";

/**
 * THE APPROVAL LINK (#1033, ADR-0027 §4).
 *
 * The address mailed to somebody whose password has just been typed. Open to
 * a signed-out stranger for the same reason `/setup/[token]` is, and more so:
 * the whole design is that the person deciding is NOT signed in, and is not
 * signed in by deciding (`web/src/hooks.server.js`'s OPEN_ROUTES).
 *
 * IT READS THE REQUEST, AND ONLY READS IT. The setup screen deliberately
 * validates nothing before asking for a password, because a screen that
 * refused a spent link would be a free oracle. This screen cannot make that
 * choice: ADR-0027 §4 requires it to show WHAT is being approved -- instance,
 * browser, address, time -- and a reader cannot judge a request they are not
 * shown. So the read happens here, and the answer for an unknown token is the
 * same single word the setup card uses for its three: `null` data, and one
 * line saying the link is no longer any good.
 *
 * NOTHING HERE DECIDES ANYTHING. Mail scanners follow links (build ruling,
 * 2026-09-18), so a GET must leave the pending sign-in exactly as it found
 * it; only `POST /api/auth/approve`, from one of the page's two buttons,
 * writes an outcome.
 *
 * Dynamic, never prerendered: a screen written for a one-use secret must not
 * be baked into a static file.
 */
export const ssr = true;
export const prerender = false;

/** @type {import("./$types").PageServerLoad} */
export async function load({ params }) {
  const request = await readSignInApproval(params.token);
  return {
    token: params.token,
    /* The moments are rendered here, by the function the MAIL renders them
       with, rather than formatted again in the browser. The reader is holding
       the mail while they look at this screen: the two have to say the same
       words, and one function is the only way to keep them saying it. A local
       clock would also put a different time in front of every reader of the
       same request, which is the opposite of what a fixed UTC moment is for. */
    request: request
      ? {
        instance: request.instance,
        device: request.device,
        where: request.where,
        requestedAt: formatApprovalMoment(request.requestedAt),
        expiresAt: formatApprovalMoment(request.expiresAt),
        state: request.state,
      }
      : null,
  };
}
