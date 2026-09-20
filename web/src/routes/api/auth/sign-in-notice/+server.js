import { json } from "@sveltejs/kit";

import { takeDeniedSignInNotice } from "orbit/server/sign-in-approvals";

import { read } from "$lib/server/api.js";

/**
 * The one line a refused sign-in leaves behind (#1033, ADR-0027 consequences).
 *
 * Somebody pressed "This wasn't me" on an approval mail. Nobody got in, which
 * is the point — but somebody knew that password, and the account holder is
 * owed that fact the next time they are actually in. So the notice waits here
 * until a signed-in reader asks for it.
 *
 * A READ THAT WRITES, deliberately. Asking TAKES the notice: every unshown
 * refusal is stamped in the same statement that answers, so the line appears
 * once and does not follow the reader from screen to screen. It is scoped to
 * the caller's own rows and takes no id from the request, so it can never
 * report somebody else's refusal.
 *
 * `null` is the ordinary answer and the one this route gives almost every
 * time. The fixture answers it too: a refusal is a real event on a real
 * account, and the fidelity gate must never photograph one.
 */
export const GET = read(
  async (_event, session) => {
    const notice = await takeDeniedSignInNotice(session.user.id);
    return json(
      { notice: notice ? { deniedAt: notice.deniedAt.toISOString() } : null },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { fixture: () => json({ notice: null }, { headers: { "cache-control": "no-store" } }) },
);
