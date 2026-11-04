import { json } from "@sveltejs/kit";

import { previewProviderLinks } from "orbit/server/local-credentials";

import { read } from "$lib/server/api.js";

/**
 * What the Administration "Sign-in providers" card shows before anything is
 * removed (#1676, ADR-0041 §6): each issuer members are linked to, with its
 * members and who removal would leave with no other way in, who the primary
 * administrator is, and whether the viewer is them and has a password.
 * Names only, never an address or a subject. Instance administrators only;
 * the engine refuses everyone else (403).
 *
 * Under fixtures it answers "no provider links", so the screen the fidelity
 * gate photographs is unchanged: a route answers from the fixture or from the
 * engine, never half of each.
 */
export const GET = read(
  async (_event, session) => {
    const preview = await previewProviderLinks(session.user.id);
    return json(preview, { headers: { "cache-control": "no-store" } });
  },
  {
    fixture: () =>
      json(
        { providers: [], primary: null, viewerIsPrimary: false, viewerHasPassword: false },
        { headers: { "cache-control": "no-store" } },
      ),
  },
);
