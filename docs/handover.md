# Orbit implementation handover

This document is the repository-based starting point for the next Codex task.
Read it with `docs/architecture-consolidation.md`,
`docs/implementation-plan.md`, and `docs/feature-register.md`. Do not rely on
previous chat history.

## Current Git state

- **Branch:** `develop`; target branch is `main`.
- **HEAD:** `b806ced refactor: reconcile orphaned portable archives`.
- **Remote state:** `develop` is seven local commits ahead of `origin/develop`.
- **Working tree:** clean when this handover was written.
- **Delivery:** none of the seven commits has been pushed, deployed, or
  represented as a testbed container. Do not push piecemeal; run the delivery
  gate first, then publish one coherent `develop` update.

## This consolidation's completed work

1. Production dependency security:
   - Upgraded Drizzle ORM, Nodemailer, Next.js and the lockfile.
   - Production `pnpm audit --prod --audit-level=high` reported no known
     vulnerabilities.

2. Household lifecycle:
   - `readWorkspace` no longer creates a `My home` household as a side effect.
   - Household creation is server-first, not optimistic/offline queued.
   - Empty/recovery landing is explicit; restored household becomes active for
     the actor.
   - Removed-name conflicts are structured and return the user to recovery.
   - One recovery UI supports creation, restore and typed administrator-only
     permanent deletion. It replaced the browser `window.prompt` flow.

3. Worker safety and IMAP:
   - IMAP receipts use SQL `FOR UPDATE SKIP LOCKED` leases (`0016`).
   - IMAP polling starts after its stored UID/UIDVALIDITY checkpoint instead of
     rescanning unseen mail.
   - Recipient alias hashes are indexed (`0017`) with bounded migration
     backfill; unindexed rows retain a safe temporary fallback.
   - Household database access is removed before filesystem cleanup.
   - Portable-archive reconciliation removes encrypted orphan files after a
     grace period.

4. UI boundary:
   - The signed-out/loading shell is now outside the authenticated dashboard
     tree, avoiding state crossover during session loading.

## Local commits awaiting a single delivery

```
158091f chore: begin architecture consolidation
5060748 refactor: make household creation server authoritative
9566ffd refactor: consolidate household recovery and receipt leases
db8ecef refactor: bound worker polling and purge side effects
5ddf8e4 refactor: separate authenticated dashboard shell
ff64d47 refactor: index imap recipient aliases
b806ced refactor: reconcile orphaned portable archives
```

## Validation already completed

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` — 21 files, 81 tests passing
- `pnpm build` — successful standalone build
- `pnpm audit --prod --audit-level=high` — no known vulnerabilities

## Work still required before calling the architecture programme complete

### 1. Authenticated browser acceptance infrastructure

There is no authenticated Playwright fixture. Do **not** add an application
sign-in bypass. Add a disposable OIDC provider to a test-only Compose profile
or CI service, provision test identities through that provider, and add
repeatable Playwright coverage for:

- first user has no persisted household until creation;
- recoverable-only user sees create/restore choices;
- instance administrator sees typed permanent deletion, non-admin does not;
- restoring activates the restored household;
- reserved name returns to recovery choices;
- IMAP review selection and discard remain private.

The existing signed-out suite is `tests/e2e/signed-out.spec.ts` and Playwright
configuration is `playwright.config.ts`.

### 2. Finish focused code extraction

- `src/components/dashboard.tsx` remains large. Extract feature sections into
  presentational components/hooks without changing behaviour: household
  navigation/landing, dashboard overview, settings drawer and item actions.
- `src/server/workspace-repository.ts` remains large. Extract workspace query
  projection, household commands and item commands into server modules while
  retaining the existing route contract and authorization checks.
- Keep `src/lib/workspace.ts` as the shared validated state/command contract;
  do not reintroduce database writes into reads.

### 3. Worker operational hardening

- Replace the per-poll IMAP alias backfill with an explicit, resumable,
  rate-bounded maintenance job if user counts grow materially. Preserve the
  temporary null-index fallback until all legacy accounts are indexed.
- Review all external storage cleanup paths for durable state-before-side-effect
  ordering. `document-worker.ts` and portable archive reconciliation are the
  current reference pattern.
- Consider a dedicated worker service only if deployment needs multiple web
  replicas; current `WORKER_ENABLED=true` remains the supported simple
  one-app-container deployment and DB leases make receipt delivery safe.

### 4. Final delivery/operations gate

Before pushing:

1. Review `git diff origin/develop...HEAD` for scope and secrets.
2. Run the repository's Compose smoke path in
   `.github/workflows/publish-container.yml` locally or in CI.
3. Run `scripts/test-backup-restore.sh` against disposable data.
4. Run browser/accessibility tests once the OIDC test profile exists.
5. Update `docs/implementation-plan.md` numbered status and
   `docs/architecture-consolidation.md` only when the gates genuinely pass.
6. Push `develop`, wait for required CI, then provide testbed update commands.

## Guardrails

- Do not push, deploy, promote `latest`, or merge `develop` into `main`
  without the delivery gate passing.
- Never commit `.env-orbit`, `.orbit-secrets`, recovery bundles, VAPID keys,
  OIDC credentials, test identities, or document data.
- Keep the normal deployment topology: Orbit + PostgreSQL + ClamAV. Tika and
  Ollama remain opt-in profiles; no AI/parser service is required for core
  operation.
