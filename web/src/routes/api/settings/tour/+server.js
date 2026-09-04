import { json } from "@sveltejs/kit";

import { tourPreferenceSchema } from "orbit/lib/preferences";
import { readTourSettings, writeTourSettings } from "orbit/server/tour-settings";

import { read, write } from "$lib/server/api.js";

/**
 * The signed-in user's own first-run tour record (#751, slice 1 of #477):
 * whether the walk has been taken, set when they skip or finish it, cleared
 * by "Take the walk again".
 *
 * The session is the only input on both verbs — no user id is accepted, so
 * there is nothing to substitute and no way to read or rewrite another
 * reader's record. `no-store` because a preference the user just changed
 * must never be served from a cache, and the write carries a CSRF token
 * because it changes state (the `/api/preferences` precedent).
 *
 * THE FIXTURE ANSWERS "ALREADY TAKEN", deliberately. Under fixtures every
 * screen in the gate is photographed as a returning reader, so the walk must
 * not open itself over seventeen other screenshots. The two tour screens are
 * the ones that want the other answer, and they say so where the rest of
 * their setup is — by answering this route themselves
 * (tests/fidelity/screens.spec.js, `tourDue`), which is how the goodbye
 * already says it is signed out.
 */
const TOUR_FIXTURE = { tour: { tourSeenAt: "2026-08-13T09:00:00.000Z" } };

export const GET = read(
  async (_event, session) => {
    const tour = await readTourSettings(session.user.id);
    return json({ tour }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json(TOUR_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);

/* No fixture branch, as with reminders: PUT belongs to the engine. */
export const PUT = write(async (event, session) => {
  const preference = tourPreferenceSchema.parse(await event.request.json());
  const tour = await writeTourSettings(session.user.id, preference);
  return json({ tour }, { headers: { "cache-control": "no-store" } });
});
