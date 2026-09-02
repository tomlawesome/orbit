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
| Reminder calculation and delivery | V1-REM-01–02 | notification domain/worker and provider calls | calendar/DST/config/retry/category units; user-level warning-day precedence units and PostgreSQL dispatch evidence (#479) | **Partially proven:** database materialization/claims, duplicate prevention, lease/restart behaviour, SMTP/Web Push contracts and DST transition boundaries remain in #41 |
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
| `/api/settings/reminders` | route contract units: session-scoped read and write, bounded outbound-mail word, crossed/out-of-range pairs refused, queued email cancelled on switch-off, CSRF and signed-out negatives; PostgreSQL per-user isolation, schema-level pair invariant and queue-drain scope; dispatch precedence units (per-item rules win, the pair is the default, unset falls back to 14/3, boundary and crossed pairs) and PostgreSQL evidence that both warnings materialise per recipient, that two members of one household are warned on their own schedules, and that a retimed pair cancels the queued delivery it no longer justifies (#479) | browser evidence that a pair edited on the settings screen changes what actually arrives |
| `/api/auth/sessions/revoke` | route contract units: user-scoped delete asserted on the compiled predicate, cookie cleared, audit with ids and a count only, CSRF/cross-site/signed-out negatives; PostgreSQL evidence that every device — the caller's included — is refused on its next request while another account is untouched | browser journey for "sign out of every device" once the v19 screen is wired |
| `/api/admin/*` | health smoke only | non-admin denial, safe redaction, corrective-state transitions and audit evidence |
| `/api/health` | running-container smoke | degraded optional dependencies and migration/readiness semantics |

## Journey evidence audit

**Audit date:** 2026-09-02
**Source revision:** `5af8dd9`

The capability table above grades how completely a capability is proven. This
table grades something narrower and blunter: for each significant product
journey, is the evidence produced by the real thing or by a stand-in.
[#618](https://github.com/tomlawesome/orbit/issues/618) exists because
[#532](https://github.com/tomlawesome/orbit/issues/532) found three defects
([#607](https://github.com/tomlawesome/orbit/issues/607),
[#610](https://github.com/tomlawesome/orbit/issues/610),
[#613](https://github.com/tomlawesome/orbit/issues/613)) in a day once repair
was finally run against a real deployment, having been green against a fake
docker shim for months.

- **Live evidence** — exercised against a real stack or the real external tool
  in an acceptance harness.
- **Fake evidence only** — unit or integration tests against shims, fixtures,
  mocks or disposable protocol sidecars. Useful, and not the same as proof
  that the journey works.
- **No evidence** — asserted nowhere.

A disposable sidecar counts as a fake here even where it drives real
application code end to end, because it is written to agree with us. The
policy question of which layer *should* cover what is settled in
[quality-strategy.md](quality-strategy.md) and is not reopened.

| Journey | Class | Evidence | Tracking |
| --- | --- | --- | --- |
| Install, fresh | **Live** | `scripts/test-install-acceptance.sh` drives an unmocked `install.sh` against real Compose, Postgres and ClamAV to a healthy `/api/health` (`:210-245`); a second real-registry install runs at `.github/workflows/publish-container.yml:1146-1243`. Fake tier: `scripts/install.test.mjs:27` | — |
| Install over the network | **Live, never scheduled** | `scripts/test-install-bootstrap.sh` fetches `install.sh` over real network and proves the channel tag resolves to the digest the registry serves. Nothing invokes it: its only reference outside itself is `AGENTS.md`, so the documented operator path is proven only when a person remembers | needs an issue |
| Upgrade to a new version | **No evidence** | `scripts/update-and-start.sh` and `scripts/deploy-container.sh` — the scripts that take the pre-update backup and gate cutover on health — are executed by no test. The only references are the CI path classifier and a source-text check (`scripts/supply-chain-policy.test.mjs:144`). `scripts/test-install-acceptance.sh:325-335` proves a rerun against the *same* image, which is not a version change | needs an issue; [#680](https://github.com/tomlawesome/orbit/issues/680) covers prior-version repair and restore, not update |
| Repair | **Live** | `scripts/test-repair-journeys.sh:38-42` runs twelve journeys against a real stack broken for real; CI at `publish-container.yml:1428`. It is the only harness in the repository that declares its own gaps in code (`:46-48`) | [#680](https://github.com/tomlawesome/orbit/issues/680) for the one absent journey |
| Backup and restore | **Live** | `scripts/test-backup-restore.sh` against the running smoke stack; CI at `publish-container.yml:872`. `scripts/restore.test.mjs` and `scripts/test-backup-restore.test.mjs` are not general restore evidence — each covers one extracted health-probe helper | [#659](https://github.com/tomlawesome/orbit/issues/659) |
| Recovery bundle export and import | **Live** | `scripts/test-backup-restore.sh:573-719` runs the real `export-recovery-bundle.sh` and `import-recovery-bundle.sh`, including a containerised decrypt (`scripts/import-recovery-bundle.sh:75-79`). `ORBIT_RECOVERY_TEST_MODE` only redirects the passphrase prompt; the crypto and archive checks are real | [#659](https://github.com/tomlawesome/orbit/issues/659) |
| Maintenance mode | **Live, with a caveat** | `tests/e2e/maintenance-recovery.spec.ts` drives the real admin control, signs out, signs back in through the guard-exempt routes, and ends the window through the real API. `scripts/test-backup-restore.sh:423-449` runs `end-maintenance.sh` for real, but *enters* maintenance by hand-written SQL (`:409-411`), so the CLI drill never exercises the app's own `openMaintenanceWindow` | [#526](https://github.com/tomlawesome/orbit/issues/526) |
| Document ingestion and scanning | **Mixed** | Live: `scripts/test-malware-scanner.sh` against real ClamAV (CI `publish-container.yml:869`), `scripts/test-tika-processor.mjs` against real Tika (CI `:772-822`, and only when its scope check trips). Fake: `src/server/documents/tika.test.ts:4` stubs `fetch`; the browser upload at `tests/e2e/authenticated-documents.spec.ts:270` is real but the draft and approve legs around it are `page.route`-mocked (`:194`, `:289`, `:308`). **Uncertain:** this audit did not establish that a document uploaded in the smoke run actually reaches the live ClamAV and Tika containers rather than short-circuiting in the server | [#42](https://github.com/tomlawesome/orbit/issues/42), [#692](https://github.com/tomlawesome/orbit/issues/692); the uncertainty needs its own issue |
| Mail and IMAP ingestion | **Fake evidence only** | The strongest evidence is `tests/e2e/v19-mail-collection.spec.ts:119`, a real SMTP delivery into the disposable GreenMail sidecar (`docker-compose.acceptance.yml:58-68`) consumed by the real IMAP poller — substantial, but a sidecar. `tests/e2e/imap-review.spec.ts:73-89` and `v19-mail-review.spec.ts:77-93` mock the API outright. The integration suites never dial IMAP (`IMAP_HOST=imap.example.invalid`). No real provider anywhere | [#22](https://github.com/tomlawesome/orbit/issues/22) |
| OIDC sign-in | **Fake evidence only** | `tests/oidc/server.mjs` is a self-signed in-memory provider with four hardcoded users (`:17-31`). `scripts/oidc-secret-contract.test.mjs` asserts Compose and entrypoint text, not protocol. Nothing in the repository has ever signed in against a real identity provider | [#14](https://github.com/tomlawesome/orbit/issues/14) |
| Push notifications | **Fake evidence only** | `tests/integration/notification-worker.test.ts:299-346` proves claim, dispatch and ledger behaviour against real Postgres with an injected fake provider. The delivery call itself — `webPush.sendNotification` at `src/server/notification-worker.ts:568` — is invoked by no test, and `tests/e2e` contains no `PushManager`, service-worker or VAPID subscription flow. The rules are proven; the send is not | [#41](https://github.com/tomlawesome/orbit/issues/41) |
| Local semantic extraction | **No evidence** | `docker-compose.yml:121` ships the Ollama sidecar and the installer offers it, but `scripts/processor-compose-contract.test.mjs` and `scripts/validate-compose-config.sh` assert the Compose configuration only, and CI's profile check (`publish-container.yml:739`, `:750-751`) never starts the container. No issue needed while the capability stays deferred; noted because the pin moved in [#647](https://github.com/tomlawesome/orbit/issues/647) with nothing able to see a break | none needed (deferred) |
| v19 front end (`web/`) | **Mixed** | Better than it was: `pnpm --filter orbit-web fidelity` runs in CI on any pull request touching `web/` (`publish-container.yml:333-392`), and `pnpm --filter orbit-web build` plus `scripts/check-v19-types.mjs` run on every pull request (`scripts/test-backend.sh:16-18`). `web/package.json:11` (`svelte-check`) still has no CI caller; the type ledger stands in for it | [#624](https://github.com/tomlawesome/orbit/issues/624) |

Two facts cut across the table. First, almost all live evidence is
conditional: the `smoke` and `repair_journeys` jobs run only on a manual
dispatch, a `ci: acceptance` label, or a system-classified change
(`publish-container.yml:467-472`, `:1391-1396`), and unconditionally only on a
push to `preview` or `hotfix/**`. An ordinary pull request is graded by the
fake tier alone. Second, `tests/e2e` holds 56 `test.skip` calls, around 30 of
them gated on `ORBIT_ACCEPTANCE_OIDC`, so most browser evidence exists only on
that same lane; the rest are mostly the desktop/mobile project split, which is
complementary rather than missing. Neither is wrong — it is the risk-proportional
design in [quality-strategy.md](quality-strategy.md) — but it means "green pull
request" and "journey proven" are further apart than they read.

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
