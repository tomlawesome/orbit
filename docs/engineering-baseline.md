# Orbit engineering baseline

**Baseline date:** 2026-07-27
**Source revision:** `8a8e37e`
**Published preview (historic tag):** `rc-2026.07.27.96`
**Preview digest:** `sha256:a1f05125ec9c95bba47c2fc977c7d235afa3ab8b7a0533b7ebeb09333b7ff543`

This audit distinguishes code that exists from behaviour that is proven ready.
It is the evidence snapshot for baseline issues
[#10](https://github.com/tomlawesome/orbit/issues/10) through
[#13](https://github.com/tomlawesome/orbit/issues/13). GitHub issues own
changing delivery status after this snapshot.

## Classification

- **Proven complete:** all v1 criteria have automated evidence and any required
  representative manual acceptance.
- **Partially proven:** implementation and useful evidence exist, but an
  important criterion or test layer is absent.
- **Implemented, unverified:** production code exists without adequate
  behavioural evidence.
- **Missing:** a v1 requirement has no sufficient implementation.
- **Deferred:** deliberately outside the stable v1 gate.

## Measured repository snapshot

- 85 passing Vitest tests across 23 files, including the planning-governance
  policy checks added by this baseline.
- 32 API route files.
- 18 ordered PostgreSQL migrations.
- Two Playwright specifications: three signed-out/privacy/accessibility
  scenarios and one authenticated household-lifecycle scenario. They are
  enumerated for desktop and mobile projects, but the stateful authenticated
  scenario intentionally runs only on desktop.
- A fast CI gate runs type checking, linting, and Vitest before any image build.
- A Compose gate builds and starts Orbit with PostgreSQL and disposable OIDC,
  checks non-root secret permissions, ClamAV detection, backup/restore,
  signed-out privacy, authenticated lifecycle, mobile layout, and automated
  accessibility.
- Gated image publication records an immutable digest. The image named above
  predates the preview terminology and is not evidence of feature completeness.
  Stable promotion is designed to reuse an accepted release-candidate digest.
- Diagnostic V8 coverage across included source and operational scripts is
  15.14% statements, 12.83% branches, 13.91% functions, and 16.40% lines. No
  blocking threshold is set.

The suite is meaningful, but no requirement-to-test traceability existed
before this audit. The low whole-source coverage baseline confirms the missing
route, repository, worker and component layers without turning a percentage
into a release target. The image-publication job also
rebuilds after the smoke-tested local image, so CI does not yet prove that the
published image is byte-for-byte the image exercised by the Compose gate.

## Capability evidence

| Capability | Requirements | Implementation evidence | Existing evidence | Classification and principal gap |
| --- | --- | --- | --- | --- |
| OIDC and sessions | V1-ID-01 | `src/lib/auth`, auth routes | OIDC/crypto/session units; disposable OIDC browser flow | **Partially proven:** representative real-provider sign-in, disabled-session revocation, and route-level failure cases remain |
| Household privacy and authorization | V1-ID-02, V1-HH-02 | authorization and workspace access modules | signed-out route checks; member/admin lifecycle browser flow; document access pure tests | **Partially proven:** no database-backed cross-household matrix across critical APIs |
| Account administration | V1-ID-03 | admin user repository/routes | indirect static/unit coverage only | **Implemented, unverified:** disable/re-enable, last-admin, owner, and session-revocation flows need integration/browser evidence |
| Household creation and lifecycle | V1-HH-01–03 | workspace and lifecycle services/routes | workspace reducer units; authenticated create/member/remove/restore browser flow | **Partially proven:** permanent purge, retention expiry, concurrent access, and negative route cases remain |
| Items, sections, schedules and history | V1-ITEM-01–02 | workspace command contract/repository and UI | reducer/domain/preference units | **Partially proven:** persistence, authorization, concurrency, and authenticated browser journeys are untested |
| Responsive UI and accessibility | V1-UX-01, V1-UX-03 | dashboard/components/styles | signed-out axe and mobile overflow checks | **Partially proven:** authenticated workspace, dialogs, settings, documents, text scaling, themes and keyboard flows are absent |
| Offline/PWA behaviour | V1-UX-02 | service worker, IndexedDB snapshot and queue | no dedicated automated evidence | **Implemented, unverified:** privacy, conflict, retry, upgrade and storage-clear behaviour need a product decision and browser tests |
| Reminder calculation and delivery | V1-REM-01–02 | notification domain/worker and provider calls | calendar/DST/config/retry/category units | **Partially proven:** database claims, duplicate prevention, SMTP/Web Push contracts and representative delivery remain |
| Secure documents | V1-DOC-01 | validation, ClamAV, envelope encryption, local storage, lifecycle worker/routes | validation/crypto/storage/scanner/authorization units; EICAR Compose check; backup marker round trip; signed-out routes | **Partially proven:** authenticated upload/download, cross-household denial, quota races, corrupt storage, purge and wrong-key recovery remain |
| Document-assisted item entry | V1-DOC-02 | manual item editor plus bounded Tika inspection | safe suggestion units | **Partially proven:** parser contract/failure cases, representative documents and authenticated browser editing/submission remain |
| Portable archives | V1-OPS-04 | encrypted archive, storage, preview/import routes | crypto/storage units | **Partially proven:** database-backed export/import authorization, conflicts, expiry, documents and failure atomicity remain |
| Administrator operations | V1-OPS-02 | health, queue, audit and corrective-action routes/UI | no focused service/route/browser suite | **Implemented, unverified:** authorization, redaction, state transitions and degraded-provider evidence remain |
| Installation and secrets | V1-OPS-01 | configure/install/deploy scripts; file-backed secrets; non-root entrypoint | Compose configuration and runtime permission checks | **Partially proven:** clean-host install, interrupted rerun, update compatibility and documented operator recovery remain |
| Migrations and update | V1-OPS-03 | Drizzle migrations and migrate-on-start entrypoint | fresh empty Compose database starts | **Partially proven:** ordered fresh-schema comparison and representative previous-version upgrade/rollback tests are missing |
| Backup and recovery | V1-OPS-04 | backup, verify, restore and encrypted recovery-bundle scripts | PostgreSQL marker plus encrypted-file round trip | **Partially proven:** corrupt manifests, wrong KEK, mixed states, interrupted restore and off-host recovery exercise remain |
| Health, audit and logging | V1-OPS-02 | health endpoints, audit table and safe failure categories | health smoke plus unit category checks | **Implemented, unverified:** redaction, audit completeness, retention and degraded-service behaviour need integration evidence |
| CI, preview and promotion | V1-REL-01 | validation and promotion workflows | successful preview run 96 and recorded digest | **Partially proven:** the published image is rebuilt after smoke; no feature-complete RC, supply-chain reports, or completed stable promotion exists |
| IMAP/SMTP ingestion | Deferred | ingestion, holding, review and receipt workers/routes | configuration, alias, TLS-header and worker-helper units | **Deferred:** live provider contract, hostile MIME, duplicate, recovery, browser review and privacy evidence are incomplete |
| Local semantic extraction | Deferred | optional Ollama container only | Compose configuration validation | **Deferred:** no application adapter or automatic-write authority is allowed |

No row is marked proven complete. That is intentional: a successful preview is
useful engineering evidence, but representative release acceptance and several
critical integration layers are still missing.

## API evidence map

| Route group | Current evidence | Required next evidence |
| --- | --- | --- |
| `/api/auth/*` | auth unit tests and one full disposable-OIDC journey | callback/session/logout failures, revocation, disabled users, origin and cache headers |
| `/api/workspace*` | reducer units; signed-out GET; lifecycle browser flow | database-backed command authorization, invalid/stale commands, concurrency and full item journey |
| `/api/preferences`, `/api/push/*` | preference and notification pure units | authenticated ownership, CSRF, endpoint redaction and provider contract tests |
| `/api/households/*` | member/admin lifecycle browser flow | owner/member/outsider matrix, last-owner rules, retention/purge and archive authorization |
| `/api/documents/*`, item documents | signed-out checks and lower-level document units | authenticated upload/download/delete/restore matrix, quota/state races and response headers |
| `/api/document-drafts/*` | suggestion pure units | Tika bounds/failure contract, duplicate modes, authorization and editable browser flow |
| `/api/portable-archives/*` | crypto/storage units | household authorization, atomic import, conflicts, expiry and corrupt/wrong-passphrase cases |
| `/api/imap-inbox/*` | IMAP helper units | user isolation, hostile/duplicate receipt states and browser review; deferred from stable gate |
| `/api/admin/*` | health smoke only | non-admin denial, safe redaction, corrective-state transitions and audit evidence |
| `/api/health` | running-container smoke | degraded optional dependencies and migration/readiness semantics |

## Risk-ranked release gaps

### P0 — stable-release blockers

1. A reusable PostgreSQL-backed service/API integration harness.
2. A negative authorization matrix for critical household, document, archive,
   membership, account, and administrator operations.
3. Fresh-install and representative upgrade migration tests.
4. Authenticated browser coverage for core item and secure-document journeys.
5. Expanded backup/restore failure and key-mismatch evidence.
6. Build-once CI so system tests and preview/RC publication use the same image
   identity.

### P1 — required professional quality

1. Authenticated accessibility, responsive, text-scale and theme coverage.
2. Administrator authorization, redaction and corrective-action tests.
3. Notification database-claim and provider-contract tests.
4. Offline/PWA support decision and evidence or removal of unsupported claims.
5. Dependency review, vulnerability reporting, SBOM, image scan and provenance.
6. Operator-tested clean installation, update, rollback decision, restart and
   off-host recovery.

### Deferred without blocking stable v1

- Live IMAP ingestion and SMTP receipt workflow.
- Local or remote semantic model integration.
- Automatic duplicate merging or model-written records.
- Object storage, horizontal scale, managed SaaS, or public sharing.

## Roadmap structure

The `v1 Engineering Baseline` delivery group is represented by issues #10–#13
and this branch. The `v1.0` roadmap contains these outcome-level epics:

1. [identity, sessions, and authorization](https://github.com/tomlawesome/orbit/issues/14);
2. [household and account lifecycle](https://github.com/tomlawesome/orbit/issues/15);
3. [core items, schedules, and reminders](https://github.com/tomlawesome/orbit/issues/16);
4. [secure documents and reviewed intake](https://github.com/tomlawesome/orbit/issues/17);
5. [data integrity, migrations, backup, and recovery](https://github.com/tomlawesome/orbit/issues/18);
6. [administration and observability](https://github.com/tomlawesome/orbit/issues/19);
7. [accessible, responsive, and offline-safe user experience](https://github.com/tomlawesome/orbit/issues/20);
8. [CI, supply chain, release, and operator acceptance](https://github.com/tomlawesome/orbit/issues/21);
9. [optional mail and document automation](https://github.com/tomlawesome/orbit/issues/22);
10. [maintainability and bounded module seams](https://github.com/tomlawesome/orbit/issues/23).

Only the first two risk areas are decomposed into implementable issues at
baseline: [#24](https://github.com/tomlawesome/orbit/issues/24) through
[#28](https://github.com/tomlawesome/orbit/issues/28). The remaining epics are
refined when they approach delivery.

## Baseline conclusion

Orbit has a credible security-conscious foundation and a working deployable
preview, not an empty prototype. Its principal quality deficit is missing
integration evidence across real persistence and authorization boundaries,
followed by core authenticated browser coverage and exact-image CI. The next
work should add those proofs around existing behaviour before extending the
feature set.
