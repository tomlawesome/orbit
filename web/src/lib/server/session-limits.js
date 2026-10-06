/**
 * The most devices "where you're signed in" ever names (#1151 A1-R7).
 * `listSessions` (orbit/lib/auth/session) has no limit of its own, so an
 * account that quietly accumulated a long tail of old sessions (a token
 * nothing ever revoked, a device nobody signed out of) sent the whole tail
 * down every time that screen was read. Its own sort already puts the
 * current session first and the rest newest-seen first, so the cap drops the
 * stalest ones, never the current or the recently active.
 *
 * Its own module, not a `+server.js` export: SvelteKit only allows HTTP
 * method names, its own per-route options, or a leading-underscore name as a
 * named export from a route file, and `SESSION_LIST_LIMIT` is none of those
 * (`pnpm --filter orbit-web build` refuses otherwise).
 */
export const SESSION_LIST_LIMIT = 20;
