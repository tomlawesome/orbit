import { json } from "@sveltejs/kit";

import { requireInstanceAdministrator } from "orbit/server/authorization";
import { getRecoveryBundleStatus } from "orbit/server/recovery-bundle-status";

import { read } from "$lib/server/api.js";

/**
 * Whether a recovery bundle has been recorded for the currently active
 * document KEK (#968, slice 1 of #966) — for the administration screen's
 * persistent "no recovery bundle exported" card. Bounded like its #956 and
 * #941 siblings: a boolean and a timestamp, never the bundle or the
 * passphrase, which this route never touches either.
 */
export const GET = read(async (_event, session) => {
  await requireInstanceAdministrator(session.user.id);
  return json(
    { recoveryBundle: await getRecoveryBundleStatus() },
    { headers: { "cache-control": "no-store" } },
  );
});
