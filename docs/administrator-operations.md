# Orbit administrator operations

This document defines the security and state-transition contract for
`ORB-FUT-004`. The operations interface is diagnostic and corrective; it is not
a generic database editor or log viewer.

## Information boundary

Only authenticated instance administrators may use operations APIs. Every
response is non-cacheable. Responses may contain:

- worker state and last successful cycle time;
- configured/unconfigured provider state;
- counts by bounded status and safe failure category;
- job identifiers, kind, attempts, lifecycle state, and timestamps;
- actor/household/action labels from the audit history.

Responses must never contain credentials, provider URLs, recipient addresses,
push endpoints or keys, raw exception text, raw audit `changes`, document
names/content/hashes/storage keys, request headers, sessions, or message bodies.

Worker boundaries convert errors to versioned categories before persistence:

- notifications: `smtp_unconfigured`, `smtp_unavailable`, `smtp_rejected`,
  `push_unconfigured`, `push_unsubscribed`, `push_unavailable`,
  `recipient_preferences_disabled`, or `unknown`;
- documents: existing controlled codes such as `key_unavailable` and
  `purge_failed`, plus `scanner_unavailable`, `scanner_timeout`,
  `scanner_protocol`, `scanner_failed`, `staging_object_invalid`,
  `scan_recovery_expired`, and `stage_purge_failed`.

Historical raw notification errors remain internal and are never returned.

## Readiness and classified diagnostics

The public `GET /api/health` endpoint is a content-free readiness probe. It
checks the required database dependency and returns HTTP `200` with `ready` or
HTTP `503` with `degraded`. Both responses are non-cacheable and identify
neither the dependency nor its error. Optional SMTP, push, IMAP, scanner, and
document-processor failures do not make core records unreadable and therefore
do not change this required-dependency result.

Authenticated administrators use the bounded diagnostics surfaces together:

| Failure class | Authoritative surface | Safe evidence |
| --- | --- | --- |
| Required dependency | `/api/health` | `ready` or `degraded` only |
| Configuration and provider | `/api/admin/operations` | configured state and allowlisted provider category |
| Queue | `/api/admin/operations` | bounded status counts, safe failure category, attempts and timestamps |
| Storage and document dependencies | `/api/admin/documents/health` | allowlisted encryption, storage, scanner, quota and worker state |

The administrator routes remain session- and administrator-protected and
non-cacheable. A degraded optional category is actionable independently and
does not disclose configuration values, provider identity, private content, or
raw dependency errors.

## Container log diagnostics

`ORBIT_LOG_LEVEL` selects operational verbosity: `error`, `warn`, `info` or
`debug`. It defaults to `info`, which reports document lifecycle progress
without debug noise. An unreadable value falls back to `info` rather than
disabling logging.

Records are one line each and greppable directly from `docker compose logs
orbit-app`. They are bounded by construction: failure reasons come from fixed
enumerations rather than provider text, and document content, extracted text,
display names, mailbox recipients and alias material are never recorded. A
document is identified only by its opaque identifier.

To follow one document through upload:

```text
docker compose logs -f orbit-app | grep document.
```

Expect `document.lifecycle` records progressing `quarantined`, `scanning`,
`encrypting`, `available`, and one `document.scan` record carrying the scanner
outcome and duration. A retryable outage instead emits a bounded
`document.scan outcome=recoverable` record and stays in `scanning` until a
worker obtains a clean result or the recovery retention expires.

A stalled or failed upload is diagnosed from the last record reached:

| Last record | Meaning | Action |
| --- | --- | --- |
| `document.scanner state=starting` | The independently starting scanner is still inside its 180-second initialisation window | Allow the stack to finish booting; uploads remain temporarily blocked |
| `document.scanner state=unreachable` | The scanner did not answer before its bounded startup window expired | Check that `orbit-clamav` is running and healthy; uploads stay blocked until it is reachable |
| `document.lifecycle state=scanning` with no following record | The scanner did not answer within `CLAMAV_TIMEOUT_MS` | Check `orbit-clamav` health |
| `document.scan outcome=error reason=unavailable` | The scanner refused or dropped the connection; the validated upload is recoverable for 24 hours | Check `orbit-clamav`; the worker retries without re-upload |
| `document.scan outcome=recoverable` | Encrypted, non-downloadable scanner-recovery stage is waiting for a bounded retry | Check the retry count and expiry in document health; use the document job only when automatic attempts are exhausted |
| `document.scan outcome=infected` | Malware was detected; the document is rejected by design | No action |
| `document.worker outcome=cycle_failed` | A maintenance cycle failed | Consult `/api/admin/documents/health` for the bounded failure code |

Orbit probes the scanner at startup when `DOCUMENT_SCAN_MODE` is `required`.
If the first probe does not answer, Orbit records `document.scanner` as
`starting` and retries in the background for the scanner's bounded 180-second
initialisation window. A successful retry records `ready`; only exhaustion of
that window records `unreachable` as an error. The probes never stop the
process: document operations fail closed while the rest of the application
stays available. An upload blocked this way returns HTTP `503` with either
`document_scanner_unreachable` or `document_scanner_failed`, which distinguish
a scanner that cannot be contacted from one that answered with a failure.
Neither message nor startup record discloses the configured host, port or
provider text.

Scanning is fail-closed while `DOCUMENT_SCAN_MODE` is `required`, so an
unavailable scanner never stores an available or unscanned document. A
retryable outage stores only authenticated-encrypted, non-downloadable stage
bytes and returns `202`; the generic scanner-reported error still returns
`503` without durable stage. Automatic recovery is limited to five attempts at
60s, 2m, 4m, 8m and 15m delays and expires after the immutable 24-hour
retention window.
`orbit-clamav` has a 180-second health start period and downloads signature
databases on first run, so uploads attempted during initial startup fail until
it becomes healthy.

## Corrective actions

All mutations require CSRF validation, administrator authorization, an exact
expected source state, and an audit event after an accepted transition. A
missing, stale, replayed, processing, or otherwise zero-row transition returns
the bounded conflict result and writes no misleading success audit.

- A failed or cancelled notification may be retried. Its attempt count, lock,
  sent time, and failure state are cleared and it is scheduled immediately.
- A pending, retrying, or failed notification may be discarded as cancelled.
- A failed scanner recovery job may be retried from attempt zero while its
  recovery expiry remains unchanged. A failed terminal stage purge may be
  retried as deletion only; it never re-enters scanning.
- Restore preserves the scanner job attempt count and failed/manual state; only
  live pending, retry, or processing leases are requeued.
- A failed document job may be discarded as cancelled. Scanner-recovery
  discard/expiry rejects metadata and schedules idempotent secure stage purge;
  a deletion error remains an administrator-visible `purge_pending` backlog,
  never a claimed success.
- Processing work is never mutated by an administrator. The API returns the
  same non-enumerating conflict response for missing and non-actionable IDs.

Notification delivery remains at-least-once: SMTP cannot guarantee that a
provider accepted a message but the subsequent database update succeeded.
Retry actions must state this duplicate-delivery risk.

Document worker completions use an unguessable lease token. A stale worker may
not overwrite a job claimed by a newer worker.

## Provider tests

The SMTP test verifies connection and authentication only. It does not send a
message and returns a bounded result category. It has a short timeout and never
returns configuration or provider response text. Push tests, when added, target
only the requesting administrator's current subscription and cannot select an
arbitrary recipient.

## Deployment configuration readiness

Run guided setup once from the persistent deployment directory, then check the
configuration before every first start or material provider change:

```sh
bash scripts/configure.sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

The first command is the non-interactive bootstrap and upgrade path: it creates
missing generated secrets and preserves existing operator settings. Guided
setup then atomically records the public HTTPS Orbit origin, complete OIDC
issuer, client ID, and derived callback URL. It does not collect provider
credentials. The separate secret step reads the OIDC client secret silently,
stores it atomically at `.orbit-secrets/oidc-client-secret` with mode `0600`,
and records only `/run/orbit-secrets/orbit-oidc-client-secret` in
`.env-orbit`. Do not provide the secret on the command line or through a
literal shell pipeline.

The readiness check validates required settings, direct-versus-file secret
ambiguity, and partially configured optional groups. Its output contains only
field names and readiness categories; it does not print values. A failed check
is an administrator action and must be resolved before deployment. Keep the
persistent `.env-orbit` file mode `0600`; direct and file-backed forms are
mutually exclusive. Ordinary configuration and recognised upgrades preserve
the OIDC secret file. Never put credentials in command arguments, terminal
history, issue text, chat, or logs.

## Mailbox provider operation

Mailbox ingestion is optional. An installation that does not use mail runs the
base `docker-compose.yml` without mail secret files. To configure it:

1. Keep `SMTP_PASSWORD`, `IMAP_PASSWORD`,
   `IMAP_ALIAS_CURRENT_SECRET`, and their deprecated direct-value aliases
   empty in `.env-orbit`.
2. Configure only the non-secret SMTP and IMAP host, port, TLS mode, account,
   sender, mailbox, recipient domain, trusted envelope-recipient header, and
   current positive alias generation in `.env-orbit`.
3. Place the SMTP password, IMAP password, and current alias key in
   `${ORBIT_SECRETS_DIR}/smtp-password`,
   `${ORBIT_SECRETS_DIR}/imap-password`, and
   `${ORBIT_SECRETS_DIR}/imap-alias-current-secret`. Supply them from a secret
   manager or private editor, not a command argument. Each path must be a
   non-empty regular file, not a symbolic link, and readable only by the
   deployment operator.
4. Validate and deploy the optional overlay:

   ```sh
   docker compose --env-file .env-orbit \
     -f docker-compose.yml -f docker-compose.mail.yml config --quiet
   COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml \
     bash scripts/deploy-container.sh --pull
   ```

The container bootstrap copies mounted Compose secrets into a private tmpfs,
sets ownership to Orbit's unprivileged runtime user, applies mode `0400`, then
drops root. The application reads only the `/run/orbit-secrets/...` copies.
Missing, partial, empty, symbolic-link, oversized, or simultaneously direct and
file-backed secrets fail closed.

SMTP and IMAP are verified independently with certificate and hostname
validation. SMTP supports required STARTTLS or implicit TLS; plaintext and
opportunistic downgrade are unsupported. IMAP uses implicit verified TLS on
the configured port without assuming that a provider uses only the default
port. Polling cannot begin until both current configurations pass preflight.
A startup outage leaves mailbox ingestion degraded and retryable while core
records, the durable cursor, existing private drafts, and cleanup obligations
remain available.

The administrator operations view exposes only these mailbox classes:

| State | Operator meaning |
| --- | --- |
| `not_configured` | Required provider or alias configuration is absent. |
| `disabled` | Polling is intentionally disabled; existing state is preserved. |
| `verification_pending` | Current configuration has not yet passed both provider checks. |
| `available` | Both provider checks passed and polling may run. |
| `provider_unavailable` | A bounded provider connection or authentication check failed. |
| `unsafe_input` | Configuration is malformed or internally inconsistent. |
| `retrying` | A content-free notification is waiting for bounded retry. |
| `exhausted` | A content-free notification reached its attempt limit. |
| `retention_backlog` | Private staging cleanup needs operator attention. |

Verification and retry actions require an authenticated instance
administrator, same-origin CSRF proof, and non-cacheable responses. They never
return hosts, account names, recipients, aliases, filenames, message or
document content, hashes, storage identifiers, credentials, or raw provider
errors. Administrator authority does not grant access to a user's private
receipt, draft, staged attachment, or authenticated review page.

Mailbox notifications are durable, leased, idempotently materialized, and
bounded on failure. Their generic body contains no source content and links
only to `/?open=inbox` on the configured HTTP(S) application origin. The link
still requires authentication and cannot approve, attach, or write anything.
SMTP remains at-least-once: if a provider accepts a message immediately before
Orbit loses its completion update, an explicit retry can duplicate the generic
notification. The interface warns before retrying exhausted deliveries.

### Disable, restart, and credential rotation

- Set `IMAP_ENABLED=false` and restart to stop new polling. Do not remove or
  reset mailbox cursor, receipt, draft, or staging state.
- A routine restart re-verifies the current provider commitment before polling
  and resumes through the durable cursor and leases.
- Rotate SMTP and IMAP credentials independently by replacing the corresponding
  host secret file atomically, restarting the exact deployed image, and
  repeating provider verification. Never place a credential in a command,
  screenshot, issue, log, or acceptance record. A partial or mismatched
  rotation remains unavailable rather than falling back to plaintext or an
  older secret.
- Re-enabling after a restart or provider outage uses the preserved cursor and
  receipt identities. It must not create a second draft or delivery operation
  for already recorded mail.

For alias-key rotation, increment `IMAP_ALIAS_CURRENT_GENERATION`, make a new
key current, and retain the exact former current generation and key as the
previous tuple with an explicit UTC expiry no more than 90 days away. Mount
that previous key only during the bounded transition:

```sh
docker compose --env-file .env-orbit \
  -f docker-compose.yml \
  -f docker-compose.mail.yml \
  -f docker-compose.mail-alias-rotation.yml \
  config --quiet
COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml:docker-compose.mail-alias-rotation.yml \
  bash scripts/deploy-container.sh --pull
```

At expiry, remove all three previous-generation settings, remove the rotation
overlay from deployment, and securely retire the old host secret file.
Omitting the complete previous tuple and rotation overlay invalidates it
immediately for an emergency rotation. Never lower or reuse a generation.

### Exact-image mailbox acceptance

Representative provider acceptance is release evidence, not an ordinary CI
secret. Use controlled provider identities, keep their credentials only in the
mounted files above, and deploy the immutable digest under test. Record the
image's `org.opencontainers.image.revision` label and require it to match the
accepted source revision.

Exercise, in order:

1. verified SMTP and IMAP TLS/authentication;
2. preservation of the configured envelope-recipient header;
3. reconnect and container restart with the durable cursor preserved;
4. one controlled PDF receipt, including a replay that creates no second
   private draft;
5. a generic notification whose link requires sign-in and opens only the
   recipient's private inbox;
6. notification content inspection proving that no source, provider,
   recipient, household, item, attachment, alias, or draft data is present;
7. bounded provider failure followed by recovery without cursor, draft, or
   delivery-identity loss.

The external harness reduces those observations to the boolean stage schema
accepted by `scripts/acceptance-mailbox.mjs`. Set the expected and inspected
digest/revision independently, use `ORBIT_ACCEPTANCE_MODE=live`, and direct the
sanitized JSON record to a private evidence path with
`ORBIT_ACCEPTANCE_EVIDENCE_FILE`. The script rejects digest/revision mismatch,
malformed or incomplete proof, and emits no raw provider material.

`ORBIT_ACCEPTANCE_MODE=fake` is deterministic synthetic contract evidence for
ordinary CI only. Its record is explicitly non-representative and cannot be
used as live provider or release acceptance.

## Hostile document processor operation

The default stack keeps `TIKA_URL` empty and does not start the `processing`
profile. Documents remain uploadable and reviewable without parser-derived
suggestions.

To opt into the pinned processor, set
`TIKA_URL=http://orbit-tika:9998`, validate the resolved Compose configuration,
and start the profile:

```sh
docker compose --env-file .env-orbit --profile processing config --quiet
docker compose --env-file .env-orbit --profile processing up -d orbit-tika orbit-app
```

Do not add host ports, application secrets, document volumes, default-network
membership, arbitrary Tika headers or caller-selected endpoints. The supplied
configuration runs Tika non-root with a read-only filesystem, disables OCR and
embedded recursion, and keeps it on the egress-denied processing network.
ClamAV uses that network for bounded scan streams and a separate network only
for signature updates; it does not share PostgreSQL's default network.

To disable extraction safely, clear `TIKA_URL`, recreate `orbit-app`, and stop
the optional processor. Already-clean encrypted originals remain available and
the review flow falls back to manual fields:

```sh
docker compose --env-file .env-orbit up -d orbit-app
docker compose --env-file .env-orbit --profile processing stop orbit-tika
```

## Audit history

Instance-wide actions may have no household, so `audit_log.household_id` is
nullable. Administrator history is cursor-paginated and selects only safe
columns. Pages use the stable descending `(created_at, id)` keyset and the
administrator interface exposes a bounded **Load older history** action rather
than replacing the current page. Equal timestamps therefore neither duplicate
nor skip events. Raw `changes` remain available solely to trusted internal
code. Retained events use only safe actor, household, and action labels after
household purge; deleted private names and raw changes are never rendered.
Unknown future action codes receive a generic label rather than exposing raw
payloads.
