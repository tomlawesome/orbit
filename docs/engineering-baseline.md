# Orbit engineering baseline

**Baseline date:** 2026-07-27
**Evidence updated:** 2026-07-28
**Source revision:** `f9dadf9`
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
  Stable promotion reuses an accepted protected-preview digest after its exact
  source reaches `main`; the version is embedded before testing.
- Build, database, malware-scanner, parser, optional-AI and disposable OIDC
  container inputs are pinned to reviewed Linux/AMD64 manifests. Pulled Orbit
  deployments require an explicit immutable application digest; local builds
  use a revision-specific local tag.
- Diagnostic V8 coverage across included source and operational scripts is
  15.14% statements, 12.83% branches, 13.91% functions, and 16.40% lines. No
  blocking threshold is set.

The suite is meaningful, but no requirement-to-test traceability existed
before this audit. The low whole-source coverage baseline confirms the missing
route, repository, worker and component layers without turning a percentage
into a release target. Subsequent CI work now builds once and tests and
publishes the same immutable image identity; feature completeness, manual
acceptance and stable promotion remain separate release gates.

## Capability evidence

| Capability | Requirements | Implementation evidence | Existing evidence | Classification and principal gap |
| --- | --- | --- | --- | --- |
| OIDC and sessions | V1-ID-01 | `src/lib/auth`, auth routes | OIDC/crypto/session units; disposable OIDC protocol/browser flow; PostgreSQL session revocation | **Partially proven:** successful atomic refresh, logout/discovery failure contracts and representative real-provider sign-in remain |
| Household privacy and authorization | V1-ID-02, V1-HH-02 | authorization and workspace access modules | PostgreSQL-backed member/admin/outsider matrix; signed-out checks; authenticated lifecycle browser flow | **Partially proven:** the core matrix is proven, while later archive, administration and document-lifecycle routes retain their issue-specific negative cases |
| Account administration | V1-ID-03 | admin user repository/routes | PostgreSQL disable/re-enable, last-admin, owner-transfer and session-revocation evidence | **Partially proven:** retention expiry and permanent purge remain part of the account-lifecycle epic |
| Household creation and lifecycle | V1-HH-01–03 | workspace and lifecycle services/routes | workspace reducer units; authenticated create/member/remove/restore browser flow | **Partially proven:** permanent purge, retention expiry, concurrent access, and negative route cases remain |
| Items, sections, schedules and history | V1-ITEM-01–02 | workspace command contract/repository and UI | reducer/domain/preference units; PostgreSQL authorization harness | **Partially proven:** non-upsert transitions lack complete stale-state guards; completion replay, persistence/history and the authenticated manual journey remain in #40 |
| Responsive UI and accessibility | V1-UX-01, V1-UX-03 | dashboard/components/styles | signed-out axe and mobile overflow checks | **Partially proven:** authenticated workspace, dialogs, settings, documents, text scaling, themes and keyboard flows are absent |
| Offline/PWA behaviour | V1-UX-02 | installable static shell and push service worker; server-authoritative workspace; legacy private-storage purge | unit policy and purge tests; authenticated startup, logout and failed-command browser scenarios | **Implemented, local evidence:** private workspace snapshots and replay queues are removed; exact-image browser acceptance remains to be recorded |
| Reminder calculation and delivery | V1-REM-01–02 | notification domain/worker and provider calls | calendar/DST/config/retry/category units | **Partially proven:** database materialization/claims, duplicate prevention, lease/restart behaviour, SMTP/Web Push contracts and DST transition boundaries remain in #41 |
| Secure documents | V1-DOC-01 | validation, ClamAV, envelope encryption, local storage, lifecycle worker/routes | validation/crypto/storage/scanner/authorization units; EICAR Compose check; backup recovery matrix; signed-out routes | **Partially proven:** purge can be marked complete before ciphertext deletion; authenticated lifecycle, quota races and interrupted/corrupt dependency states remain in #42 |
| Document-assisted item entry | V1-DOC-02 | manual item editor plus bounded Tika inspection | safe source-aware suggestion units | **Partially proven:** optional no-document entry, parser failure containment, explicit-submit semantics, representative documents and authenticated editable browser evidence remain in #43 |
| Portable archives | V1-OPS-04 | encrypted archive, storage, preview/import routes | crypto/storage units | **Partially proven:** database-backed export/import authorization, conflicts, expiry, documents and failure atomicity remain |
| Administrator operations | V1-OPS-02 | health, queue, audit and corrective-action routes/UI | no focused service/route/browser suite | **Implemented, unverified:** authorization, redaction, state transitions and degraded-provider evidence remain |
| Installation and secrets | V1-OPS-01 | configure/install/deploy scripts; file-backed secrets; non-root entrypoint | Compose configuration, digest-pinned upstream images, explicit pulled application identity and runtime permission checks | **Partially proven:** clean-host install, interrupted rerun, update compatibility and documented operator recovery remain |
| Migrations and update | V1-OPS-03 | Drizzle migrations and migrate-on-start entrypoint | ordered fresh-schema, supported-baseline upgrade, idempotency and failure-recording tests | **Partially proven:** automated migration integrity is established; operator update, rollback and clean-host acceptance remain |
| Backup and recovery | V1-OPS-04 | backup, verify, restore and encrypted recovery-bundle scripts | corrupt/wrong-key/mismatched-object/interrupted restore matrix plus successful PostgreSQL and encrypted-file recovery | **Partially proven:** automated recovery safety is established; documented off-host operator recovery remains |
| Health, audit and logging | V1-OPS-02 | health endpoints, audit table and safe failure categories | health smoke plus unit category checks | **Implemented, unverified:** redaction, audit completeness, retention and degraded-service behaviour need integration evidence |
| CI, preview and promotion | V1-REL-01 | validation and promotion workflows | fast issue lanes, protected build-once `preview` publication, automatic train versions, source checks, dependency/secret and dependency-change licence policy, exact-image vulnerability/SPDX evidence, verified digest-bound attestations and immutable digest recording | **Partially proven:** automated contracts are established; representative protected-preview acceptance and completed stable promotion remain |
| IMAP/SMTP ingestion | V1-DOC-03 | ingestion, holding, review and receipt workers/routes | configuration, alias, TLS-header and worker-helper units | **Partially proven:** live provider contracts, hostile MIME, identity, duplicate/retry recovery, shared draft review and privacy evidence remain in #22 |
| Local semantic extraction | Deferred | optional Ollama container only | Compose configuration validation | **Deferred:** no application adapter or automatic-write authority is allowed |

No row is marked proven complete. That is intentional: a successful preview is
useful engineering evidence, but representative release acceptance and several
critical integration layers are still missing.

## API evidence map

| Route group | Current evidence | Required next evidence |
| --- | --- | --- |
| `/api/auth/*` | auth units; disposable-OIDC protocol/browser journey; PostgreSQL revocation and disabled-user evidence | successful atomic refresh, logout/discovery failure contracts, cache headers and representative real-provider acceptance |
| `/api/workspace*` | reducer units; signed-out GET; PostgreSQL authorization matrix; lifecycle browser flow | invalid/stale item transitions, completion replay/concurrency and the full authenticated manual item journey |
| `/api/preferences`, `/api/push/*` | preference and notification pure units | authenticated ownership, CSRF, endpoint redaction and provider contract tests |
| `/api/households/*` | PostgreSQL owner/member/outsider and last-owner matrix; member/admin lifecycle browser flow | retention/purge and archive authorization |
| `/api/documents/*`, item documents | signed-out checks, PostgreSQL access matrix and lower-level document units | authenticated upload/download/delete/restore lifecycle, quota/state races, purge recovery and response headers |
| `/api/document-drafts/*` | source-aware suggestion pure units | Tika bounds/failure contract, no-document path, explicit-submit/abandonment semantics, authorization and editable browser flow |
| `/api/portable-archives/*` | crypto/storage units | household authorization, atomic import, conflicts, expiry and corrupt/wrong-passphrase cases |
| `/api/imap-inbox/*` | IMAP helper units; route contract units for the list read: attachment names re-sanitised on the way out, bounded media type and clean verdict, filed mail→item provenance, the left-household and cross-reader negatives (every predicate compiled and asserted bound to the session's own user id) | user isolation, hostile/duplicate receipt states, recovery and browser review remain required in #22; PostgreSQL evidence that a filed item survives its receipt's 45-day burn-up |
| `/api/settings/mail-relay` | route contract units: session-derived alias, bounded listening/ingest words, `no-store`, instance-admin and mail-in-off states, and nothing leaked about host/port/mailbox | PostgreSQL evidence that the newest receipt read is the caller's own, plus rotation and per-user pause when those land |
| `/api/settings/reminders` | route contract units: session-scoped read and write, bounded outbound-mail word, crossed/out-of-range pairs refused, queued email cancelled on switch-off, CSRF and signed-out negatives; PostgreSQL per-user isolation, schema-level pair invariant and queue-drain scope | reminder dispatch consuming the stored pair (per-item rules still govern sending today) |
| `/api/auth/sessions/revoke` | route contract units: user-scoped delete asserted on the compiled predicate, cookie cleared, audit with ids and a count only, CSRF/cross-site/signed-out negatives; PostgreSQL evidence that every device — the caller's included — is refused on its next request while another account is untouched | browser journey for "sign out of every device" once the v19 screen is wired |
| `/api/admin/*` | health smoke only | non-admin denial, safe redaction, corrective-state transitions and audit evidence |
| `/api/health` | running-container smoke | degraded optional dependencies and migration/readiness semantics |

## Risk-ranked release gaps

### P0 — stable-release blockers

1. Conflict-safe item transitions and authenticated manual item coverage
   ([#40](https://github.com/tomlawesome/orbit/issues/40)).
2. Recoverable document purge and authenticated secure-document lifecycle
   coverage ([#42](https://github.com/tomlawesome/orbit/issues/42)).
3. Optional document-assisted item entry that remains editable and persists
   nothing before explicit submission
   ([#43](https://github.com/tomlawesome/orbit/issues/43)).
4. Dedicated-mailbox ingestion into the same private, explicitly approved
   review flow ([#22](https://github.com/tomlawesome/orbit/issues/22)).

Completed baseline blockers now include the reusable PostgreSQL harness,
critical negative authorization matrix, fresh/baseline-upgrade migration
proof, expanded restore-failure matrix, and build-once exact-image CI. Their
accepted issues and protected runs retain the detailed evidence.

### P1 — required professional quality

1. Authenticated accessibility, responsive, text-scale and theme coverage.
2. Administrator authorization, redaction and corrective-action tests.
3. Notification database-claim and provider-contract tests
   ([#41](https://github.com/tomlawesome/orbit/issues/41)).
4. Offline/PWA support decision and evidence or removal of unsupported claims.
5. Dependency review, vulnerability reporting, SBOM, image scan and provenance.
6. Operator-tested clean installation, update, rollback decision, restart and
   off-host recovery.

### Deferred without blocking stable v1

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
9. [reviewed mail and document ingestion](https://github.com/tomlawesome/orbit/issues/22);
10. [maintainability and bounded module seams](https://github.com/tomlawesome/orbit/issues/23).

The completed first delivery group is
[#24](https://github.com/tomlawesome/orbit/issues/24) through
[#28](https://github.com/tomlawesome/orbit/issues/28). The active Wave 2 group
is [#40](https://github.com/tomlawesome/orbit/issues/40) through
[#43](https://github.com/tomlawesome/orbit/issues/43), plus the remaining
session and representative-provider evidence within
[#14](https://github.com/tomlawesome/orbit/issues/14). Later epics remain
outcome-level until current evidence makes their next slices decision-complete.

## Baseline conclusion

Orbit has a credible security-conscious foundation and a working deployable
preview, not an empty prototype. PostgreSQL integration, critical negative
authorization, migration/recovery safety and exact-image CI now have useful
automated evidence. The next release risks are conflict-safe item behaviour,
secure document purge/lifecycle, bounded reminder delivery and complete
authenticated core journeys. Those accepted contracts then support the
required reviewed mailbox-ingestion flow without granting inbound content
automatic write authority.
