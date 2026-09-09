/**
 * The three states where the sign-in door cannot simply be opened (#788),
 * as pure decisions: no fetch, no timer, no DOM. `SignIn.svelte` owns the
 * fetching, the polling interval and the recovery animation; this file owns
 * only what the door says and when it says it, so both can be pinned without
 * a browser (design/v19/signin-states/round-1/README.md, owner-ratified
 * direction C, "the held dawn").
 *
 * `DOOR` is the ordinary case — the button. The other three replace it:
 * `UNCONFIGURED` (authentication is not set up), `STARTING` (the server's own
 * boot sequence has not finished yet, and is expected to clear on its own —
 * #869), `FAILED` ("Orbit couldn't open safely" — the catch-all for a check
 * that could not be trusted at all, or a genuine fault once boot is done).
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
 * Reads `GET /api/auth/availability`'s `phase` field (#869) into one of the
 * two words `registerNode`'s boot sequence can be in (`src/server/boot.ts`),
 * or `null` when it cannot be trusted at all — same convention as
 * {@link readinessOf}. Kept separate from {@link availabilityOf} rather than
 * folded into its shape, so a caller that only needs to decide whether to
 * poll again never has to also parse `configured`.
 *
 * @param {unknown} body
 * @returns {"starting" | "running" | null}
 */
export function phaseOf(body) {
  if (!body || typeof body !== "object") return null;
  const phase = /** @type {{ phase?: unknown }} */ (body).phase;
  return phase === "starting" || phase === "running" ? phase : null;
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
 * The one decision this module exists for: given this round's boot phase,
 * readiness and availability reads, what the door becomes next (#869).
 *
 * `phase` decides starting vs. not, not readiness: the server's own boot
 * fact terminates by construction (`registerNode`), which is what lets the
 * door's poll end instead of running forever on a broken instance. A
 * `degraded` or unreadable readiness answer is no longer read as "still
 * starting" — read that way, a dead database looked identical to a slow
 * boot and the door waited on it forever.
 *
 * Precedence, in order: an unreadable phase fails closed to `FAILED`;
 * `"starting"` is always `STARTING`, whatever readiness or availability say
 * — there is nothing to report as broken yet. Once `"running"`, a degraded
 * or unreadable readiness read is a genuine fault and fails immediately to
 * `FAILED` rather than waiting on it; an unreadable availability answer is
 * `FAILED` too; otherwise the door opens, or names why it cannot, purely on
 * `configured`.
 *
 * @param {{ phase: "starting" | "running" | null, readiness: "ready" | "degraded" | "maintenance" | null, availability: { configured: boolean, contactAddress: string | null } | null }} read
 * @returns {typeof DOOR | typeof UNCONFIGURED | typeof STARTING | typeof FAILED}
 */
export function nextDoorState(read) {
  if (read.phase === null) return FAILED;
  if (read.phase === "starting") return STARTING;
  if (read.readiness === null || read.readiness === "degraded") return FAILED;
  if (read.availability === null) return FAILED;
  return read.availability.configured ? DOOR : UNCONFIGURED;
}

/**
 * WHAT THE OPEN DOOR ASKS FOR (#914, ADR-0022, ADR-0023 §1, plan §2.7).
 *
 * A door that CAN open still has three faces, and which one it wears is the
 * owner's 2026-09-09 composition ruling, not a preference:
 *
 * `CLAIM` — the instance has no primary administrator yet. The ring holds
 * the claim-code card and there is no Sign in gate at all, because there is
 * nobody to sign in as.
 *
 * `LOCAL` — claimed, and local accounts are the only way in. The ring holds
 * the sign-in card: an email address and a password.
 *
 * `MIXED` — claimed, with an identity provider. The ratified door is
 * unchanged — the gate, exactly as #788 left it — and the only addition is
 * one quiet "local login" line under it, and only when a local credential
 * actually exists.
 *
 * These are the states of an OPEN door, which is why they are decided
 * separately from {@link nextDoorState}: `UNCONFIGURED`, `STARTING` and
 * `FAILED` are the door being unable to open at all, and nothing here
 * overrides them.
 */
export const CLAIM = "claim";
export const LOCAL = "local";
export const MIXED = "mixed";

/**
 * Reads `GET /api/auth/availability`'s claim and method fields into one of
 * the three faces above. Kept separate from {@link availabilityOf} for the
 * same reason {@link phaseOf} is: a caller deciding what the door DRAWS asks
 * a different question from one deciding whether it may open at all, and
 * folding them into one shape would make every existing reader of that shape
 * care about M7.
 *
 * Reads exactly three fields and no others, so a chatty or hostile body can
 * no more reach this decision than it can reach the door's own words:
 * `claimed`, `methods.oidc` and `methods.localAccounts`.
 *
 * TWO DEFAULTS, BOTH CONSERVATIVE, both chosen so an unreadable answer lands
 * on the screen that was already ratified rather than on a new one:
 *
 *   · `claimed` missing or not a boolean reads as CLAIMED. The route itself
 *     takes the same line ("a visitor is never told an instance is unclaimed
 *     on the strength of a failed read"), and the claim endpoints re-check
 *     the row regardless, so nothing is authorised by this guess.
 *   · `methods` missing or unreadable reads as MIXED — the ratified door. An
 *     answer that does not say whether an identity provider is configured is
 *     not evidence that there isn't one, and the gate is the screen every
 *     reader already knows.
 *
 * `localAccounts` is the separate fact of whether any local credential
 * exists (§2.7); `methods.local` says only that local sign-in is a method
 * this build has, which is always true, and is deliberately not read here.
 *
 * `oidc` rides back out because CLAIM mode needs it after the mode itself is
 * decided: the create card that follows a successful claim offers the
 * provider in one line, or does not, on exactly this fact.
 *
 * @param {unknown} body
 * @returns {{ mode: typeof CLAIM | typeof LOCAL | typeof MIXED, localAccounts: boolean, oidc: boolean }}
 */
export function doorModeOf(body) {
  const record = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const methods = record.methods && typeof record.methods === "object"
    ? /** @type {Record<string, unknown>} */ (record.methods)
    : null;
  const readable = Boolean(methods) && typeof methods?.oidc === "boolean";
  const oidc = readable ? methods?.oidc === true : true;
  const localAccounts = readable && methods?.localAccounts === true;

  if (record.claimed === false) return { mode: CLAIM, localAccounts: false, oidc };
  if (!readable) return { mode: MIXED, localAccounts: false, oidc: true };
  return { mode: oidc ? MIXED : LOCAL, localAccounts, oidc };
}

/**
 * THE CODE IN THE FRAGMENT (ADR-0022 §1).
 *
 * The claim notice is a link whose code rides in the URL **fragment**, never
 * a query string: browsers do not send fragments, so reverse proxies, access
 * logs and `Referer` headers never see it. This reads it out; `SignIn.svelte`
 * clears the address bar with `history.replaceState` before it POSTs, so a
 * screenshot, a bookmark or a shoulder cannot keep the code either.
 *
 * The alphabet is the notice's own — base32 in groups of four — and nothing
 * outside it is accepted, so a fragment carrying anything else (a router
 * anchor, an attacker's payload) reads as no claim at all rather than as a
 * code that will be sent somewhere. Case is normalised up because the notice
 * says the code is case-insensitive on entry.
 *
 * @param {string | null | undefined} hash the raw `location.hash`, "#" and all
 * @returns {string | null}
 */
export function claimFromHash(hash) {
  if (typeof hash !== "string") return null;
  const match = /^#claim=([A-Za-z2-7]{1,4}(?:-[A-Za-z2-7]{1,4})*)$/u.exec(hash.trim());
  return match ? match[1].toUpperCase() : null;
}

/**
 * ORBIT'S OWN WORDS FOR A REFUSED CARD (ADR-0023 §8).
 *
 * The four cards read the `error` code off the response and say this. The
 * body's own message is never shown: it is written for an operator reading a
 * log, and echoing server text onto a signed-out screen is exactly the habit
 * the door's other wording rules exist to prevent.
 *
 * Nothing here names a field, a count or a remaining time — `credentials_invalid`
 * is deliberately one sentence for an unknown address, a wrong password, a
 * disabled account and an account with no password, because the route answers
 * all four identically and a friendlier message would undo that.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function cardMessageFor(code) {
  switch (code) {
    case "bootstrap_invalid":
      return "That code is not the one this instance printed.";
    case "bootstrap_claimed":
      return "This Orbit has already been claimed. Reload to sign in.";
    case "bootstrap_unavailable":
      return "This instance has no code waiting. Restart it and read the notice in its log.";
    case "bootstrap_required":
      return "That code has expired. Enter it again.";
    case "credentials_invalid":
      return "That email address and password do not match an Orbit account.";
    case "too_many_attempts":
      return "Too many attempts. Try again shortly.";
    case "password_rejected":
      return "That password is too short or too long.";
    case "setup_token_invalid":
      return "This link has been used already, or it has expired.";
    case "invalid_request":
      return "Fill in every field.";
    default:
      return "That didn’t work. Try again.";
  }
}

/**
 * The STARTING backstop's own bound (#869): 2 minutes, matching the issue's
 * own words. A process can hang mid-boot without exiting, so the STARTING
 * poll cannot rely on "boot terminates" alone to end — this is the
 * fallback, not the mechanism.
 */
export const STARTING_BACKSTOP_MS = 120_000;

/**
 * The other pure decision in this module (#869): given the state
 * {@link nextDoorState} already decided for this round, a deadline and the
 * caller's own clock read, whether the door keeps polling or gives up.
 *
 * Only ever changes anything when `state` is `STARTING`: any other state
 * has already resolved to something the door acts on immediately, and is
 * returned unchanged regardless of the deadline — there is nothing left to
 * poll for. `SignIn.svelte` owns the timer and the deadline arithmetic
 * (`Date.now() + STARTING_BACKSTOP_MS`, read once when STARTING is first
 * shown); this function only ever reads clock values it was handed, which
 * is what lets the backstop itself be pinned without a browser or a real
 * clock, the same way {@link nextDoorState} is.
 *
 * @param {typeof DOOR | typeof UNCONFIGURED | typeof STARTING | typeof FAILED} state
 * @param {number} deadline epoch ms after which STARTING gives up
 * @param {number} now epoch ms, the caller's own `Date.now()` read
 * @returns {typeof DOOR | typeof UNCONFIGURED | typeof STARTING | typeof FAILED}
 */
export function applyStartingBackstop(state, deadline, now) {
  if (state !== STARTING) return state;
  return now >= deadline ? FAILED : STARTING;
}
