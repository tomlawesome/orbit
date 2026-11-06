import { json } from "@sveltejs/kit";

import { readWhatsNew } from "orbit/server/whats-new";

import { read } from "$lib/server/api.js";

/**
 * What the signed-in user is shown in the what's-new notice (#1618):
 * `{ version, releases }`, the running version and every release newer than
 * the one they last saw, newest first. The session is the only input.
 * `no-store` because it changes the moment they dismiss it.
 *
 * Under fixtures the list is empty, as `/api/settings/tour` answers "already
 * taken": screenshots stay still.
 */
export const GET = read(
  async (_event, session) => {
    const answer = await readWhatsNew(session.user.id, { runningVersion: process.env.ORBIT_VERSION ?? null });
    return json(answer, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json({ version: null, releases: [] }, { headers: { "cache-control": "no-store" } }) },
);
