import { json } from "@sveltejs/kit";

import { getAuthConfig } from "orbit/lib/env";
import { getBootPhase } from "orbit/server/boot";
import { readPublicContactAddress } from "orbit/server/instance-contact";

/**
 * Whether the signed-out sign-in door may offer to sign in, and where to say
 * so if it cannot (#788, #860, #869).
 *
 * Unauthenticated and reaches no session, on purpose: `/login` is prerendered
 * static HTML that reaches no database on its own (`web/src/routes/login/
 * +page.js`), and this is how it learns — client-side, in `onMount`, the same
 * way it already learns `returnTo` — whether authentication is configured at
 * all. `/api/health` deliberately does not carry this signal: that contract
 * belongs to the installer and the container HEALTHCHECK and must not shift.
 * `getAuthConfig()` throwing is the signal instead, and only the boolean
 * crosses the boundary — never the error itself, which is exactly what keeps
 * provider-supplied detail from ever reaching this response (the old e2e's
 * zero-occurrence assertion this route exists to preserve).
 *
 * The contact address rides along on the same read because the door is the
 * one and only signed-out surface that ever needs it (#860's non-goals rule
 * out a general public "instance profile"): anything that cannot tell whether
 * sign-in is configured has no other reason to ask for this either.
 *
 * `phase` (#869) is the one field that decides whether the door polls at
 * all: `"starting"` until `registerNode`'s own boot sequence finishes,
 * `"running"` for good after. It carries no detail beyond the two words —
 * no error text, no dependency name — for the same reason `configured` never
 * carries the thrown error: a signed-out visitor learning which subsystem
 * failed is reconnaissance, not diagnosis they are owed.
 */
export async function GET() {
  let configured = true;
  try {
    getAuthConfig();
  } catch {
    configured = false;
  }
  let contactAddress = null;
  try {
    contactAddress = await readPublicContactAddress();
  } catch {
    // Non-critical to the door's headline signal; a hiccup reading the
    // address must not be mistaken for authentication being unconfigured.
    contactAddress = null;
  }
  const phase = getBootPhase();
  return json({ configured, phase, contactAddress }, { headers: { "cache-control": "no-store" } });
}
