import { json } from "@sveltejs/kit";

import { readRelaySettings } from "orbit/server/mail-in/relay-settings";

import { RELAY_FIXTURE } from "$lib/data/fixtures/relay.js";
import { read } from "$lib/server/api.js";

/**
 * The signed-in user's own relay (#432): their mail-in address, whether Orbit
 * is listening, when something last arrived, and the instance's ingest flag.
 *
 * A GET, so no CSRF token; the session is the only input, which is what makes
 * it impossible to ask for another user's relay. `no-store` is not decoration:
 * the address is a capability-bearing value that must never sit in a cache.
 * Nothing here logs, and no failure path can carry the address, because
 * `appErrorResponse` only ever emits its own bounded codes.
 */
export const GET = read(
  async (_event, session) => {
    const relay = await readRelaySettings(session.user);
    return json({ relay }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json(RELAY_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);
