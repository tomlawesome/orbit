/**
 * WHAT THE FAILED CALLBACK SAYS (#1056, design/v19/auth-error/round-1/,
 * direction B — "the held dawn, refused" — owner-ratified 2026-09-19: "I
 * preferred B, the held dawn. But we don't give out admin emails."
 *
 * `web/src/routes/api/auth/callback/+server.js`'s `callbackFailure` sends
 * every failed OIDC callback to `/auth/error?code=…`. Every code it can send
 * (`AuthErrorCode` in `src/lib/auth/errors.ts`, folded to `provider_error`
 * for anything `asAuthError` does not recognise) reads as one of two faces,
 * pure and pinnable without a browser exactly as `door-state.js` pins the
 * three states it owns — a DIFFERENT family, kept in its own file rather
 * than folded into that one: `nextDoorState`'s automaton decides whether the
 * door may open at all, from a phase/readiness/availability read; this
 * decides which face a door that already failed to open wears, from a code
 * off a redirect, and the two have no state in common.
 *
 * `account_disabled` is the one code where trying again is a lie — the
 * administrator switched the account off, and no retry reopens it — so it
 * gets its own REFUSED face with no pill. Every other code, known or not
 * (including no code at all), is INCOMPLETE: nothing was changed, and the
 * door is still there to try again.
 *
 * The words are fixed, Orbit's own, in the voice #788's ratified table set
 * (owner, 2026-09-06). Nothing the provider or the callback sent — not its
 * `code`, not the closed token-exchange reason — ever reaches the screen;
 * `code` is read only to choose a row, the same way `cardMessageFor` reads
 * one, and is never shown. The round-1 README's own wording table paired
 * both sublines with "let us know at «address»"; the owner's 2026-09-19
 * verdict struck that sentence entirely rather than replacing it — no
 * contact address is offered anywhere on this screen (#1070 drops the same
 * sentence from the rest of the door).
 */
export const INCOMPLETE = "incomplete";
export const REFUSED = "refused";

const MESSAGES = {
  [INCOMPLETE]: {
    primary: "Sign-in didn’t complete.",
    sub: "Nothing was changed.",
  },
  [REFUSED]: {
    primary: "Sign-in was refused.",
    sub: "The administrator has disabled this account.",
  },
};

/*
 * A refusal with a reason the person can act on keeps its face but says why
 * (#1242). `link_required` (ADR-0023 §3): a provider identity whose email
 * already belongs to an Orbit account is refused, and the ADR fixes the words
 * — the same `refusals.link_required` message `src/lib/auth/provision.ts`
 * throws. Its face stays INCOMPLETE because the way back to the door IS the
 * remedy: sign in there with the existing account. Before this the screen
 * said only "Nothing was changed.", which read as a broken sign-in.
 */
const MESSAGES_BY_CODE = {
  link_required: {
    primary: "Sign-in didn’t complete.",
    sub: "An Orbit account already uses this email address. Sign in to it and link this provider from settings.",
  },
};

/**
 * @param {string | null | undefined} code the callback's `code` query
 *   parameter, read exactly as the page finds it — untrusted, and never
 *   itself shown
 * @returns {typeof INCOMPLETE | typeof REFUSED}
 */
export function authErrorStateFor(code) {
  return code === "account_disabled" ? REFUSED : INCOMPLETE;
}

/**
 * @param {typeof INCOMPLETE | typeof REFUSED} state
 * @param {string | null | undefined} [code] the same untrusted `code`; only
 *   picks a row, never shown
 * @returns {{ primary: string, sub: string }}
 */
export function authErrorMessageFor(state, code) {
  if (state === INCOMPLETE && code && Object.hasOwn(MESSAGES_BY_CODE, code)) {
    return MESSAGES_BY_CODE[/** @type {keyof typeof MESSAGES_BY_CODE} */ (code)];
  }
  return MESSAGES[state] ?? MESSAGES[INCOMPLETE];
}
