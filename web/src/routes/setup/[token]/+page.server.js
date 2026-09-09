/**
 * THE SETUP LINK (#914, plan §2.7; ADR-0022 §5, ADR-0023 §3).
 *
 * The address an administrator hands a new local user, and the address the
 * `orbit auth recovery-link` CLI prints for a locked-out primary
 * administrator. Open to a signed-out stranger for the same reason
 * `/invite/[token]` is: a signed-out stranger is exactly who it is written
 * for (`web/src/hooks.server.js`'s OPEN_ROUTES).
 *
 * IT DOES NOT VALIDATE THE TOKEN, and that is a decision rather than an
 * omission. `src/server/local-credentials.ts` (slice 8) exposes
 * `issueSetupToken` and `consumeSetupToken` and no read in between: there is
 * no way to ask "does this token exist and has it expired" without spending
 * it, and adding one belongs to whoever owns that file, not to this screen.
 * So the card is drawn for every token that is the right shape, and
 * `POST /api/auth/local/setup` is the one thing that ever decides — which it
 * already does, with the single generic `setup_token_invalid` covering
 * unknown, spent and expired alike.
 *
 * That order is also the better one for the reader. A screen that refused a
 * spent link before asking for a password would be a free oracle telling
 * anyone holding a guess whether it was a live one; this way the only answer
 * a guesser can obtain costs them a password attempt and the verification
 * gate's own time, and says nothing about which of the three it was.
 *
 * This load reaches no database and no session. It exists to carry the token
 * out of the route parameter and to keep the route dynamic: a screen written
 * for a one-use secret must never be prerendered into a static file.
 */
export const ssr = true;
export const prerender = false;

/** @param {{ params: { token: string } }} event */
export function load({ params }) {
  return { token: params.token };
}
