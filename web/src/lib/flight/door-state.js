/**
 * The three states where the sign-in door cannot simply be opened (#788),
 * as pure decisions: no fetch, no timer, no DOM. `SignIn.svelte` owns the
 * fetching, the polling interval and the recovery animation; this file owns
 * only what the door says and when it says it, so both can be pinned without
 * a browser (design/v19/signin-states/round-1/README.md, owner-ratified
 * direction C, "the held dawn").
 *
 * `DOOR` is the ordinary case — the button. The other three replace it:
 * `UNCONFIGURED` (authentication is not set up), `STARTING` (readiness is
 * degraded and expected to clear on its own), `FAILED` ("Orbit couldn't open
 * safely" — the catch-all for a check that could not be trusted at all).
 */
export const DOOR = "door";
export const UNCONFIGURED = "unconfigured";
export const STARTING = "starting";
export const FAILED = "failed";

/** The two states whose wording never varies. `FAILED` is handled by {@link failedMessage}. */
const FIXED_MESSAGES = {
  [UNCONFIGURED]: {
    primary: "Sign-in isn’t set up yet.",
    sub: "The administrator needs to configure authentication before the door can open.",
  },
  [STARTING]: {
    primary: "Orbit is waking up.",
    sub: "Sign-in will appear by itself in a moment.",
  },
};

/**
 * "Orbit couldn't open safely." (#788, #860's dependency, owner-ratified
 * 2026-09-06). With a public contact address set, the reader is invited to
 * write in; with none, Orbit's own line simply stops — no empty address, no
 * dangling "at", and never a real administrator's own mailbox.
 *
 * `contactAddress` is the only thing this function reads out of whatever it
 * is handed, and it is trusted only as far as `availabilityOf` already
 * trusted it (a string or nothing) — nothing else ever reaches these two
 * sentences, which is what keeps provider- or attacker-supplied text from
 * ever riding along on this state.
 *
 * @param {string | null | undefined} contactAddress
 */
export function failedMessage(contactAddress) {
  const address = typeof contactAddress === "string" ? contactAddress.trim() : "";
  return {
    primary: "Orbit couldn’t open safely.",
    sub: address
      ? `It’s not you, it’s us. If it keeps happening, let us know at ${address}.`
      : "It’s not you, it’s us.",
  };
}

/**
 * The words for a given state — Orbit's own, always; nothing here can ever
 * echo a provider's or a network response's own text.
 *
 * @param {typeof DOOR | typeof UNCONFIGURED | typeof STARTING | typeof FAILED} state
 * @param {string | null} [contactAddress]
 * @returns {{ primary: string, sub: string }}
 */
export function doorMessageFor(state, contactAddress) {
  if (state === FAILED) return failedMessage(contactAddress);
  if (state === UNCONFIGURED || state === STARTING) return FIXED_MESSAGES[state];
  return { primary: "", sub: "" };
}

/**
 * Reads `GET /api/health`'s public body into one of the three words the
 * guard below reasons about, or `null` when the body cannot be trusted at
 * all — a non-JSON body, a network failure the caller already turned into
 * `null`, or a status this door has no story for. `null` is not a fourth
 * state: {@link nextDoorState} always resolves it to `FAILED`.
 *
 * @param {unknown} body
 * @returns {"ready" | "degraded" | "maintenance" | null}
 */
export function readinessOf(body) {
  if (!body || typeof body !== "object") return null;
  const status = /** @type {{ status?: unknown }} */ (body).status;
  return status === "ready" || status === "degraded" || status === "maintenance" ? status : null;
}

/**
 * Reads `GET /api/auth/availability`'s public body (#788, #860): whether the
 * door may offer to sign in, and the address to name if it cannot. This
 * function reads only these two fields — anything else on the body, however
 * chatty or hostile, never reaches the caller, which is what keeps a
 * compromised or merely talkative response from ever surfacing provider
 * detail on the page (the old e2e's zero-occurrence assertion, carried
 * forward as a property of the shape itself rather than a filter over free
 * text).
 *
 * @param {unknown} body
 * @returns {{ configured: boolean, contactAddress: string | null } | null}
 */
export function availabilityOf(body) {
  if (!body || typeof body !== "object") return null;
  const record = /** @type {{ configured?: unknown, contactAddress?: unknown }} */ (body);
  if (typeof record.configured !== "boolean") return null;
  const contactAddress = typeof record.contactAddress === "string" ? record.contactAddress : null;
  return { configured: record.configured, contactAddress };
}

/**
 * The one decision this module exists for: given this round's readiness and
 * availability reads, what the door becomes next.
 *
 * Precedence, in order: an unreadable readiness answer fails closed to
 * `FAILED` rather than guessing; a degraded readiness is `STARTING`
 * regardless of anything else (availability is not even worth asking about
 * yet); an unreadable availability answer — asked only once readiness is not
 * degraded — is also `FAILED`; otherwise the door opens, or names why it
 * cannot, purely on `configured`.
 *
 * @param {{ readiness: "ready" | "degraded" | "maintenance" | null, availability: { configured: boolean, contactAddress: string | null } | null }} read
 * @returns {typeof DOOR | typeof UNCONFIGURED | typeof STARTING | typeof FAILED}
 */
export function nextDoorState(read) {
  if (read.readiness === null) return FAILED;
  if (read.readiness === "degraded") return STARTING;
  if (read.availability === null) return FAILED;
  return read.availability.configured ? DOOR : UNCONFIGURED;
}
