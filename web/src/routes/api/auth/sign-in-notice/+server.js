import { json } from "@sveltejs/kit";

import { readDeniedSignInNotice } from "orbit/server/sign-in-approvals";

import { read } from "$lib/server/api.js";

/**
 * Whether a refused sign-in has marked the caller's password (#1033, #1881).
 *
 * Somebody pressed "This wasn't me" on an approval mail: nobody got in, but
 * somebody knew the password. Since #1881 that is security state on the
 * credential rather than a one-time notice: the next sign-in lands on the
 * set-new-password step, and this route only reports the mark to a reader
 * who still holds a session from before it. A PURE READ: asking does not
 * spend it, and only a saved password clears it, after which this answers
 * `null`. Scoped to the caller's own account; it takes no id from the
 * request, so it can never report somebody else's refusal.
 *
 * The fixture answers `null`: a refusal is a real event on a real account,
 * and the fidelity gate must never photograph one.
 */
export const GET = read(
  async (_event, session) => {
    const notice = await readDeniedSignInNotice(session.user.id);
    return json(
      { notice: notice ? { deniedAt: notice.deniedAt.toISOString() } : null },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { fixture: () => json({ notice: null }, { headers: { "cache-control": "no-store" } }) },
);
