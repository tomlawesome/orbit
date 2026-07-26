# Orbit implementation handover

This document is the repository-based starting point for the next Codex task.
Read it with `docs/architecture-consolidation.md`,
`docs/implementation-plan.md`, and `docs/feature-register.md`. Do not rely on
previous chat history.

## Current delivery state

- **Implementation branch:** `codex/oidc-browser-acceptance`; draft pull
  request [#7](https://github.com/tomlawesome/orbit/pull/7) targets `develop`.
- **Validated revision:** `5b28c058971c586f5bb753a25b345c3b96b5ee25`.
- **CI:** workflow run 80 passed static/unit checks plus the full Compose
  smoke gate: image build/startup, private secret permissions, ClamAV,
  backup/restore, signed-out privacy, authenticated OIDC browser tests and
  accessibility.
- **Local validation:** `pnpm lint`, `pnpm typecheck`, `pnpm test` (81 tests),
  `pnpm build`, and `git diff --check` all pass.
- **Next delivery action:** publish a `release/` candidate from this exact
  validated revision, record its immutable digest, then perform real-world
  manual acceptance before merging or promoting `main`/`latest`.

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

## Follow-up work (not a blocker for the current release candidate)

### 1. Authenticated browser acceptance infrastructure

The disposable OIDC fixture and lifecycle coverage are complete without an
application sign-in bypass. The remaining coverage gap is IMAP review selection
and discard in a browser using an isolated fixture; current unit-level privacy
and configuration tests remain in place.

### 2. Finish focused code extraction

- `src/components/dashboard.tsx` remains large. Extract feature sections only
  when a future product change benefits from that boundary; do not block the
  operational candidate on a behaviour-neutral split.
- `src/server/workspace-repository.ts` remains large. Further query/command
  extraction is likewise deferred; the shared access controls are already
  extracted and current contracts are covered by tests.
- Keep `src/lib/workspace.ts` as the shared validated state/command contract;
  do not reintroduce database writes into reads.

### 3. Worker operational hardening

- Replace the per-poll IMAP alias backfill with an explicit, resumable,
  rate-bounded maintenance job if user counts grow materially. Preserve the
  temporary null-index fallback until all legacy accounts are indexed.
- Document purge, household purge, and portable-archive reconciliation now
  commit durable state before encrypted-file cleanup. A failed cleanup is an
  orphan reconciled later, never a reason to hold database state open.
- Consider a dedicated worker service only if deployment needs multiple web
  replicas; current `WORKER_ENABLED=true` remains the supported simple
  one-app-container deployment and DB leases make receipt delivery safe.

### 4. Final delivery/operations gate

Before promoting beyond the release candidate:

1. Review `git diff origin/develop...HEAD` for scope and secrets.
2. Deploy the candidate's exact digest to the intended test environment.
3. Run the real OIDC provider, IMAP/SMTP, and routine user workflow checks
   applicable to that environment.
4. Record manual acceptance, then merge through the protected workflow and
   promote the exact digest without rebuilding.

## Guardrails

- Do not push, deploy, promote `latest`, or merge `develop` into `main`
  without the delivery gate passing.
- Never commit `.env-orbit`, `.orbit-secrets`, recovery bundles, VAPID keys,
  OIDC credentials, test identities, or document data.
- Keep the normal deployment topology: Orbit + PostgreSQL + ClamAV. Tika and
  Ollama remain opt-in profiles; no AI/parser service is required for core
  operation.
