# ADR-0035: The engine serves its own API; the web app is a client of it, sign-in included

**Status:** Accepted
**Date:** 2026-10-08
**Relates to:** [ADR-0018](0018-engine-library-and-adapter-node-packaging.md)
(whose one-process, one-origin position this keeps and whose folder table it
changes); [ADR-0034](0034-engine-owns-every-rule.md) (whose seam this
completes); issue #1326

## Context

ADR-0034 moved every rule into the engine, but the engine's front door is
still in the front end's package: the API's 78 handlers live under
`web/src/routes/api/**`, written against SvelteKit's request event, with their
middleware (`web/src/lib/server/`) beside them. And the web shell learns who is
signed in by calling engine code directly — `hooks.server.js` resolves the
session cookie into `locals.session`, and the approve and invite pages import
the engine — rather than asking the API as any other client would.

So the engine cannot be used without the web package, and the seam that
ADR-0034 enforces at the rules has a hole at the transport. The owner's
position (2026-10-08): sign-ins work via the API, and the handlers move into
the engine's folder properly.

## Decision

The standard pattern: **the engine exposes its HTTP API as a request handler;
the web shell mounts it and is otherwise a client.**

1. **The engine owns its API.** `src/server/http/` holds a framework-neutral
   router (web-standard `Request` in, `Response` out; cookies read from the
   header) with the handlers under the same paths they have today, and the
   middleware that was `web/src/lib/server/` — session, CSRF, maintenance,
   body limit, error mapping. Handler tests move with them.
2. **The shell mounts it in-process.** `web/src/hooks.server.js` hands every
   `/api/*` request to the engine's handler. One process and one origin are
   unchanged, so the `__Host-` cookies and the same-origin write check hold
   exactly as ADR-0018 requires. This is the one import of `orbit/*` that
   `web/` keeps.
3. **Sign-in is read over the API.** Hooks and page loads learn the session
   by calling `/api/auth/session` through `event.fetch` — the same process,
   the cookie forwarded — and keep the answer in `locals`. The approve and
   invite pages call their API routes the same way.
4. **The seam is enforced.** ADR-0034's lint rule tightens to: nothing under
   `web/` imports `orbit/*` except the mount.
5. **Sequence.** After #1325's rule moves, which change what the handlers
   do; moving and changing at once doubles the review. Its own batch,
   `Cut: risk`.

## Consequences

- A second client — a CLI, a native app, or the web app moved to its own
  repository — needs the engine's handler and nothing from `web/`.
- The session lookup becomes an in-process self-request per page load:
  microseconds, and no network hop, since the handler is called directly.
- Handlers lose SvelteKit's `event` conveniences (`cookies`, `locals`,
  `json()`); a small web-standard shim replaces them once, in the router.
- ADR-0018's folder table is out of date: `src/routes/api/**` and
  `src/lib/server/` leave `web/` for `src/server/http/`.

## Alternatives rejected

- **Thin `+server.js` files delegating to engine modules.** Keeps 78 stubs
  and SvelteKit's request shape as the API's contract; the engine still
  cannot serve itself.
- **A separate API process behind a proxy.** Breaks the one-origin
  guarantees ADR-0018 rests on, for no gain while both halves ship in one
  image. Open to revisit if they ever ship separately.
- **Leave sign-in as direct calls.** The shell would stay a privileged
  client; the hole in the seam is exactly the part a second client needs.
