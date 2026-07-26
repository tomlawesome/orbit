# Orbit implementation handover

This document is the repository-based handover for a new Codex task. Treat it
with `docs/implementation-plan.md` and `docs/feature-register.md` as the source
of truth; do not rely on a previous chat's memory.

## Current Git state

- **Working branch:** `feature/mobile-lifecycle`
- **Target branch:** `release/secure-documents`
- **Draft pull request:** [#6](https://github.com/tomlawesome/orbit/pull/6)
- **Latest committed implementation:** `5fb3d8a feat: add encrypted portable archive foundation`
- The working tree was clean when this handover was written.

Do not promote to `main`, update `latest`, or publish a stable public release
until the stable completion checklist in the implementation plan is complete
through item 10. `release/secure-documents` is the integration branch for
accepted, CI-gated candidates.

## Completed foundations

- Orbit dashboard, OIDC sign-in, household isolation, roles and signed-out
  privacy.
- Configurable sections, themes/colourways, urgency palettes and in-app text
  sizing.
- Encrypted document storage, ClamAV scanning, recovery-key handling,
  retention, reconciliation and backup/restore.
- GitHub CI/release workflow and container deployment tooling.
- Administrator operations views, safe job retry/discard controls and SMTP
  connection testing.
- Mobile readability improvements, extra-large text sizing, member self-leave
  protection and reversible administrator account disable/enable.

## Active work in PR #6

1. **Mobile/lifecycle candidate**
   - Compact phone hierarchy and more readable item cards.
   - Non-owner members can leave their household; owners cannot leave it
     ownerless.
   - Disabled accounts have Orbit sessions revoked, cannot sign in or be added
     to a household, and cannot remove the final active administrator.
   - Migration: `drizzle/0005_account_lifecycle.sql`.

2. **Optional local Tika profile**
   - `docker-compose.yml` contains `orbit-tika` behind the `processing`
     profile, using `apache/tika:3.2.2.0-full`.
   - It has no published port and is resource-bounded.
   - Enable only when required with `docker compose --profile processing up -d`
     and configure `TIKA_URL=http://orbit-tika:9998` in `.env-orbit`.
   - Adapter: `src/server/documents/tika.ts`; it sends bytes directly to Tika,
     has a timeout and bounds extracted text. It does not create items or drafts.

3. **Portable archive cryptographic foundation**
   - `src/server/portable-archive.ts` provides AES-256-GCM archive encryption
     with scrypt-derived keys and a user-supplied passphrase that is never
     persisted.
   - Focused test: `src/server/portable-archive.test.ts`.
   - This is groundwork only: household archive generation, temporary storage,
     expiry/purge, audited download and import preview are still required.

## Stable completion checklist

The canonical numbered list is in `docs/implementation-plan.md`. Keep the same
numbers and update statuses in place; do not renumber it.

1. Release integration and acceptance — in progress.
2. Reviewed Tika extraction — in progress; profile and adapter exist.
3. Data portability — in progress; archive crypto exists.
4. Household lifecycle deletion/recovery/purge — planned.
5. Mobile document capture — planned.
6. User-approved document draft creation — planned.
7. Duplicate comparison — planned.
8. IMAP ingestion and SMTP review/receipt workflow — planned.
9. Local Ollama extraction — optional; requires a fresh product decision.
10. Final operational/release polish — planned.

## Agreed architecture decisions

- Standard deployment stays one Orbit container plus PostgreSQL, with existing
  ClamAV protection. Do not add parser or model services to the default stack.
- Tika is the first optional local document processor. Test it on representative
  documents before considering anything heavier.
- Docling is a replacement parser only if Tika's layout/table quality is proven
  insufficient; do not run both speculatively.
- Ollama is optional and local-only. It is not OCR and must never be required
  for normal operation or allowed to write household data automatically.
- Exports use user-passphrase-encrypted archives, expire after 24 hours, are
  household-scoped and audited. Import must show a preview and avoid partial
  commits.
- Account disable is reversible; it revokes sessions and retains data/audit
  history. Never disable the final active instance administrator.
- Household deletion requires typed confirmation and a 30-day recovery period.
- Email ingestion uses IMAP for receipt and SMTP for outbound mail. It must use
  verified TLS, a dedicated mailbox/per-user aliases, idempotency and explicit
  user review before any item creation.

## Immediate next implementation steps

Continue item 3 before starting new feature areas:

1. Build a household-scoped export service from normalized database records.
2. Include a versioned JSON manifest, hashes and optionally decrypted original
   document bytes in the portable payload.
3. Encrypt the payload with `portable-archive.ts`; store it in a private,
   short-lived location with a 24-hour expiry and cleanup job.
4. Add authenticated, audited request/download endpoints and a small Personalise
   UI flow that asks for a passphrase twice without retaining it.
5. Add import parsing/preview and transactionally validate all records before a
   later commit action.

Do not run the full local suite repeatedly. Use targeted type/lint/unit checks
at meaningful milestones, then rely on GitHub Actions for the authoritative
static, Compose, browser, accessibility and privacy gates. Never expose or
commit credentials, keys, passwords, `.env-orbit`, `.orbit-secrets`, recovery
bundles or document contents.
