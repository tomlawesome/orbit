# ADR-0018: The engine is a library, `orbit-web` links it, adapter-node ships it

**Status:** Accepted
**Date:** 2026-09-05
**Relates to:** [ADR-0012](0012-front-end-leaves-react.md), whose packaging
position and "keep the API surface intact" position this supersedes; issue
#735

## Context

Orbit ships **one framework, to no users.** ADR-0012 cut Next and React and
rebuilt the front end on SvelteKit, but left one question open: once `src/app/`
and its 45 route handlers are gone, where does the surviving engine —
`src/server/`, `src/lib/`, `src/db/`, `src/cli/` — live, and how does the
SvelteKit server reach it?

Two things have to survive whatever answer is chosen.

- **One origin, one process.** Today both applications run in one process on
  one socket, dispatched by path. That is what makes the `__Host-` cookie
  prefix and the same-origin write check (`assertSameOrigin`) sufficient —
  neither guarantee holds if the API becomes a network hop behind a proxy or a
  second origin.
- **`pdfjs-dist` and `@napi-rs/canvas` resolve.** Both are currently resolved
  through `.next/standalone`'s dependency tracing: `pdfjs-dist` locates its
  worker and cmap assets by on-disk path, and `@napi-rs/canvas` is a native
  module. Neither survives being bundled, and `.next/standalone` goes with
  Next.

Because Orbit has no installed base, the packaging answer did not have to
preserve any existing surface for its own sake (ADR-0012's 2026-09-03
amendment): the only constraints were the two above, plus not breaking the
type-checking split between the engine's strict TypeScript and the front
end's JS+JSDoc `svelte-check` ledger.

## Decision

The root package **is the engine**, not a wrapper around it.

```
/                    package "orbit" — engine: TS, strict, tsc --noEmit, Vitest
  src/server/        engine domain logic
  src/lib/           config, auth, backup, deploy
  src/db/            drizzle schema + migrate.ts
  src/cli/           the orbit CLI
  src/server/boot.ts renamed from src/instrumentation-node.ts
web/                 package "orbit-web" — SvelteKit, JS+JSDoc, svelte-check ledger
  src/routes/api/**  the real API routes
  src/lib/server/    the thin SvelteKit adaptation layer
```

1. **Root `package.json` exports the engine as a library.** An `exports` map
   (`./server/*`, `./lib/*`, `./db`, `./db/schema`) points at TypeScript
   source directly — there is no build step and no `tsc` emit. The engine
   stays source-only, type-checked by root `tsc --noEmit` exactly as before.
2. **`orbit-web` consumes it as a workspace link, not a build artifact.**
   `web/package.json` takes `"orbit": "workspace:*"`, and
   `web/vite.config.js` sets `ssr: { noExternal: ["orbit"] }` so Vite
   transforms the linked TypeScript source in dev and bundles it into the
   `adapter-node` output for production. This is the same bundle-TS-with-a-
   bundler approach `scripts/bundle-orbit-cli.mjs` already uses with esbuild
   for the CLI.
3. **The engine's nine runtime dependencies are declared twice, on purpose.**
   `@napi-rs/canvas`, `pdfjs-dist`, `drizzle-orm`, `postgres`, `jose`,
   `nodemailer`, `imapflow`, `web-push` and `zod` are `dependencies` of both
   `package.json` files, so Vite externalizes them (rather than bundling
   them) and `adapter-node`'s pruned production install carries them on disk
   next to the code that imports them. A contract test,
   `scripts/engine-runtime-deps-contract.test.mjs`, asserts `web/package.json`
   declares every one of the engine's runtime dependencies at the same
   version, so the two lists cannot drift.
4. **The engine imports no framework.** The six files that used to import
   from `next` are re-signed against Web-standard types (`Headers`,
   `Response`) plus two structural interfaces in `src/lib/http.ts`:
   `CookieReader` and `CookieSink`. SvelteKit's `event.cookies` satisfies both
   without an adapter object, so a route handler passes it straight through.
   `web/src/lib/server/api.js` supplies the one thing every route still
   needs: `api()` wraps a read handler and maps engine errors to the shared
   envelope, `write()` additionally runs the CSRF and maintenance checks — the
   same order the Next-era glue used.
5. **Boot moves from Next's instrumentation hook to SvelteKit's `init`.**
   `src/instrumentation-node.ts` became `src/server/boot.ts`
   (`registerNode`), called from `init` in `web/src/hooks.server.js`, guarded
   by `building` so a prerendering build machine never touches a database or
   starts a worker.
6. **The output is `adapter-node`, and nothing else runs.** There is no
   custom server and no dispatcher. The built `web/build` directory is the
   whole application server, started as `node web/index.js`; it answers the
   API routes as well as drawing the screens.

## Consequences

**Image layout.** The runtime image carries `web/` (the `adapter-node`
build output) and `web/node_modules` (the front end's production
dependencies, which is where the engine's nine runtime dependencies actually
live on disk). There is no `.next` anywhere. The engine's own source is not
copied into the runtime image as a separate tree — it is bundled into
`web/build` at build time.

**The installer and `orbit-launcher` are untouched at the interface.** They
consume the built image — a container exposing `/api/health` on one port —
and never see the workspace-link boundary inside it. Nothing about a deployed
database or configuration changes because of this decision.

**One origin, one process, carried across intact.** The package boundary
between `orbit` and `orbit-web` is a module boundary, resolved by Vite at
build time, never a network hop at run time. The `__Host-` cookie prefix and
`assertSameOrigin` keep meaning what they meant before the cut.

**The dependency-superset contract is load-bearing, not decorative.** Adding
a runtime dependency to the engine without adding it to `web/package.json`
resolves fine in the repo, where the root package already has it, and then
throws `MODULE_NOT_FOUND` only in the built image — the worst place to find
out. The contract test in `scripts/engine-runtime-deps-contract.test.mjs`
catches the omission at commit time instead.

**The route set is enumerated, not inferred.** `web/src/routes/api/` answers
46 route families today (`tests/unit/api-route-set-contract.test.mjs` lists
them literally), not the 24 first scoped when this packaging shape was
proposed — the wider list is ADR-0012's own amendment: the cut ports what the
new front end *needs*, not only what it currently calls. The test exists so a
route removed by accident during any future refactor fails loudly here,
rather than only once its caller — which for `/api/auth/callback` and
`/api/health` is not `web/` at all — breaks in production.

## Alternatives rejected

- **Move the engine into `web/`.** Rejected: it would drag roughly 100 files
  into the SvelteKit package, along with `install.sh`, `repair.sh`,
  `bundle-orbit-cli.mjs`, `drizzle.config.ts`, `classify-changed-paths.mjs`,
  the coverage ratchets, and the integration test suite — none of which have
  anything to do with the front end — and would mix strict TypeScript into a
  package whose type-checking is JS+JSDoc under `svelte-check`.
- **Collapse to a single root package.** Rejected: it collides the two
  packages' type-checking regimes — the engine's strict TypeScript
  (`allowJs: false`) against the front end's `checkJs`-based JSDoc ledger —
  for no offsetting benefit. Keeping them as two packages linked by a
  workspace reference keeps each ledger meaningful on its own terms.

## Superseded

This ADR supersedes [ADR-0012](0012-front-end-leaves-react.md)'s packaging
position and its "keep the API surface intact" position — recorded there as
`pdfjs-dist` and `@napi-rs/canvas` being "currently resolved through
`.next/standalone`" and needing to be "re-solved for `adapter-node` output."

The reason those positions no longer hold is the same no-users ruling
ADR-0012 already records: "I do not want any work being done to 'transition'
from Next to the new UI in a smooth way, as if we have users who need to
migrate — we don't have any users yet. Just cut Next out and build the new
UI." (owner, 2026-09-03, quoted in issue #735). There was no installed base
whose calls had to keep working through the packaging change, so the
question was purely architectural: where does the engine live, and how does
it reach the request. Decisions 1–6 above are that answer, escalated to and
ruled on by Fable 5 (2026-09-03) under the standing rule that reserves
architecture and macro system-design calls for the top-tier model, and landed
on `dev` in PR #774 (merge `2de45bc`, 2026-09-04).
