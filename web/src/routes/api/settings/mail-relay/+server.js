import { json } from "@sveltejs/kit";

import { readRelaySettings, relayGenerationOf, rotateRelayAddress, setRelayIngest } from "orbit/server/mail-in/relay-settings";
import { RelayPreconditionError } from "orbit/server/mail-in/relays";

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
 *
 * The `ETag` is the relay's generation (#1848 W-R1): a rotate sends it back as
 * `If-Match`, so a press against an address the member no longer holds is
 * refused (412) rather than rotating the one they have not seen. It names no
 * member, only a count, so ADR-0017's rule that only the session names the
 * member stands.
 */
export const GET = read(
  async (_event, session) => {
    const relay = await readRelaySettings(session.user);
    return json({ relay }, { headers: relayHeaders(relay) });
  },
  { fixture: () => json(RELAY_FIXTURE, { headers: { "cache-control": "no-store" } }) },
);

/**
 * `no-store`, and the generation the reading came from as a strong `ETag`.
 * @param {import("orbit/server/mail-in/relay-settings").RelaySettings} relay
 */
function relayHeaders(relay) {
  const generation = relayGenerationOf(relay);
  return { "cache-control": "no-store", ...(generation === null ? {} : { etag: `"${generation}"` }) };
}

/**
 * The generation an `If-Match` names (RFC 9110 section 13.1.1): undefined for
 * none, or `*`, which any relay matches. A tag this route never gave matches
 * nothing, so it is refused like a stale one.
 * @param {string | null} header
 * @returns {number | undefined}
 */
function expectedGenerationOf(header) {
  if (header === null || header.trim() === "*") return undefined;
  const match = /^\s*"([1-9][0-9]{0,9})"\s*$/u.exec(header);
  if (!match) throw new RelayPreconditionError();
  return Number(match[1]);
}

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
 * same reason, and the new `ETag`.
 *
 * A rotate or cut off with `If-Match` happens only from that generation (412
 * `relay_changed` otherwise), and either is refused past the member's limits
 * (429 `relay_rotation_limited`, with `Retry-After`). A lost race is 409.
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
    : await rotateRelayAddress(session.user, action, expectedGenerationOf(event.request.headers.get("if-match")));
  return json({ relay }, { headers: relayHeaders(relay) });
});
