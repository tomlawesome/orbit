import { json } from "@sveltejs/kit";

import { readRelaySettings, rotateRelayAddress, setRelayIngest } from "orbit/server/mail-in/relay-settings";

import { RELAY_FIXTURE } from "$lib/data/fixtures/relay.js";
import { read, write } from "$lib/server/api.js";

/**
 * The signed-in member's own relay (#432): their mail-in address, whether Orbit
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

/**
 * Acting on the member's own relay: rotating the address (ADR-0017 decision 2,
 * slice 3, #744) and pausing or resuming collection (slice 5, #746).
 *
 * The body carries an action and nothing else. THERE IS NO USER FIELD, and
 * adding one would break the invariant this endpoint exists to keep: the
 * session's user is the only user this can ever act on, so a member cannot
 * rotate, and therefore cannot cut off, anybody else's address. Every extra
 * field in the body is ignored for the same reason.
 *
 * `rotate` keeps the old address working for fourteen days so mail already in
 * flight still arrives. `cut_off` stops it now, which is what a member reaches
 * for when the address has leaked. `pause` holds whatever arrives — recorded,
 * but nothing fetched, staged or notified — and `resume` stages all of it,
 * exactly once.
 *
 * The response is the same shape a GET answers with, including the NEW address
 * — the member has to be able to save it — and the same `no-store`, for the
 * same reason.
 */
export const PUT = write(async (event, session) => {
  const body = await event.request.json().catch(() => null);
  const action = body && typeof body === "object" ? body.action : undefined;
  if (!["rotate", "cut_off", "pause", "resume"].includes(action)) {
    return json(
      { error: { code: "relay_action_invalid", message: "The relay action must be rotate, cut_off, pause or resume" } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const relay = action === "pause" || action === "resume"
    ? await setRelayIngest(session.user, action === "pause")
    : await rotateRelayAddress(session.user, action);
  return json({ relay }, { headers: { "cache-control": "no-store" } });
});
