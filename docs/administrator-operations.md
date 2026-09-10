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

## Operational log contract

`ORBIT_LOG_LEVEL` remains compatible with the existing `error`, `warn`,
`info`, and `debug` values and defaults to `info`. `ORBIT_LOG_FORMAT` is an
optional secure control with `text` (the default) or `json`. Invalid values
fall back to the safe default. Both formats are renders of one event model;
they do not create separate vocabularies or fields.

Every record has a timestamp, level, component, event, lifecycle `state`, and
bounded `reason`, `action`, `impact`, and `duration_ms` values. Configuration
problem records additionally use fixed `setting`, `problem_code`, and
`fallback` values. Records may end with a `detail` — a short quoted phrase for
what the fixed vocabulary cannot say on its own, such as which migration
disagreed. Its wording comes from Orbit's own source; only identifiers such as
migration tags and counts are filled in, so a detail never carries SQL,
configuration values or credentials. Text is one line with stable columns.
JSON has the same fields and meanings. Colour is used only for a real TTY, is automatically off
for `NO_COLOR`, non-TTY, redirected, and JSON output, and is never added to
collected logs.

The lifecycle states are `starting`, `ready`, `degraded`, `retrying`,
`recovered`, `exhausted`, `stopping`, `disabled`, `invalid`, `blocked`, and
`completed`. Components cover application, configuration, authentication,
database/migrations, notification and delivery, document/scanner/parser,
mail receipt/ingestion, backup/recovery, and shutdown. Unchanged steady states
such as `ready` are suppressed for the process lifetime. Persistent failure
and retry states are re-emitted after a fixed 60-second cooldown, and an
unhealthy-to-healthy transition is emitted as `recovered`; initial `starting`
to `ready` remains `ready`.

Ordinary logs never contain raw exceptions, stack traces, provider responses,
SQL, filenames, paths, hosts, URLs, recipients, tokens, user/household/
document identifiers, message/document content, or configuration values.
Worker catches classify the failure and continue their bounded polling loop;
unexpected process-level startup failures remain fail-closed and are never
silently swallowed. Database notices and launcher errors are reduced to fixed
classifications.

The relevant event groups are:

| Component | Starting/healthy path | Failure and operator action |
| --- | --- | --- |
| Application/configuration | `application.startup` and `configuration.problem` | invalid or optional settings are blocked/degraded with safe fallback and a fixed remediation |
| Authentication | `auth.configuration`, `auth.provider` | discovery/token/callback failures block sign-in without provider detail |
| Database/migrations | `database.connection`, `database.migration` | notices, unavailable connections, and migration integrity failures remain bounded |
| Document/scanner/parser | `document.lifecycle`, `document.scan`, `document.parse`, `document.worker` | required scanning fails closed; retries, recovery, and exhaustion identify the safe action |
| Notifications/delivery | `notification.worker`, `delivery.smtp`, `delivery.push` | provider failures are categorized and retried or exhausted without recipients |
| Mail receipt/ingestion | `imap.receipt`, `imap.ingestion` | preflight and worker failures show bounded retry/degraded state |
| Backup/recovery/shutdown | `backup.operation`, `recovery.operation`, `shutdown.signal` | scripts and runtime operators use fixed recovery/stopping classifications |

Backup and restore remain explicit operator actions. Their CLI output is
static and content-free; the application event vocabulary reserves the same
bounded backup/recovery states for integrations without logging archive paths
or private data.

## Logs, audit, health, and administrator diagnostics

Logs answer “what operational transition occurred?” and are ephemeral. The
audit trail answers “what security or data action was accepted?” and persists
the existing safe action labels. Public health remains the unchanged,
content-free required-database readiness contract. The administrator-only
operations surface answers “what is the current bounded state and what safe
operator action is available?” It includes the in-memory configuration problem
registry: fixed code, severity, setting category, safe fallback, and
remediation only. It is exposed through the existing administrator-protected
operations route; signed-out and non-administrator callers receive the same
authorization failure and cannot read diagnostics.

Roll out with the default text format and the existing level. Enable JSON only
for a controlled collector that handles the same privacy contract. To roll
back, unset `ORBIT_LOG_FORMAT` or restore `text`; no database migration or
external telemetry service is involved. If a new classification is needed,
add it to the bounded model and tests before use rather than logging arbitrary
values.

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

## Maintenance mode and the way back in

Maintenance closes Orbit to users while administrators keep full access
(ADR-0013). Administrators pass the request guard on every route, so the
maintenance control needs no exempt path: a non-administrator probing it during
maintenance receives the same bounded `503` as any other path, and the control
is neither discoverable nor invocable from outside.

Sign-in stays open while maintenance is active — the sign-in page and the OIDC
login, callback, session and logout routes are exempt — so the ordinary
recovery path is simply to sign in and end maintenance from the control.

`/api/health` answers `200` with `status: maintenance` while the instance is
closed but healthy, so orchestrators keep routing traffic to it and do not
restart it. Only a genuine dependency failure answers `503 degraded`.

### The emergency path, when OIDC itself is down

If no administrator can sign in, reopen the instance from the host:

```sh
bash scripts/end-maintenance.sh
```

The script runs the application's own deactivation function inside the already
published image, as a disposable one-off (ADR-0015). It never edits the
database directly: the write is versioned and audited exactly as an
administrator's would be, with a null actor and `origin: operator_shell` in the
audit row, so the recovery is visible in the audit history afterwards.

It also cancels any scheduled notice that has already come due. Effective
maintenance is the singleton being active *or* such a notice existing, so
clearing one without the other would leave the instance closed and the operator
still locked out.

The script is idempotent: running it against an instance that is already open
changes nothing, writes no audit row, and still succeeds. It requires the
database to be reachable, which is true whenever maintenance is what stands
between users and a running instance.

## Adding a local user

Local sign-in is always available, whether or not OIDC is also enabled. From
**Administration → Users**, enter the new user's email, display name, and how
long their setup link should stay valid (1 to 14 days, default 7), then
create the account. Orbit **emails the setup link to that address** — it is
never shown on screen, never returned by the API, and never recoverable after
the fact. The new user opens it, sets their own password, and is signed in.

Because the link only ever leaves by mail, **an instance with no working SMTP
configured cannot add a local user.** Configure SMTP first (see "Mailbox
provider operation" below for the provider-verification contract outbound
mail shares with inbound). If sending fails at creation time, the account
still exists and the row shows a bounded reason with a Retry action, so
nothing needs recreating.

A local user who has forgotten their password gets the same mechanism: "Send
a new setup link" on their row in the users table, behind the same recent-
authentication challenge as any other sensitive action. Issuing a new link
invalidates any earlier one for that user. See
[authentication.md](authentication.md#administrator-adding-a-local-user) for
the operator-facing walkthrough, including what to tell a new user.

## Recovering the primary administrator

If the primary administrator has forgotten their local password, or only ever
used OIDC and has lost the provider, recover from the deployment host:

```sh
docker compose --env-file .env-orbit exec orbit-app node /opt/orbit/cli/orbit.js auth recovery-link
```

The command reads `instance_authority` for the current primary administrator,
mints a one-time setup link for them, revokes every session they held, records
the `recovery_link_issued` audit entry, and prints that one URL to the
terminal — nothing else. Opening the link sets (or replaces) the primary
administrator's local password and signs them in. The link expires **5
minutes** after issue: an administrator doing this should be doing it
instantly, and a stale link answers the same `setup_token_invalid` as any
other expired or already-used setup link. It never touches `is_instance_admin`
and never moves primary authority, so it cannot bypass the last-administrator
or primary-administrator invariants.

Anyone who can run `docker compose exec` on the host can recover the primary
administrator at any time (ADR-0022 §6). That is the trust boundary this
command sits inside, not a gap it introduces: host access to the running
deployment already means full control of it.

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
setup first asks whether to sign in with local accounts only or also with an
identity provider (`ORBIT_AUTH_OIDC`, default local-only); answering "also"
atomically records the public HTTPS Orbit origin, complete OIDC issuer,
client ID, and derived callback URL. It does not collect provider
credentials. The separate secret step reads the OIDC client secret silently,
stores it atomically at `.orbit-secrets/oidc-client-secret` with mode `0600`,
and records only `/run/orbit-secrets/orbit-oidc-client-secret` in
`.env-orbit`. Do not provide the secret on the command line or through a
literal shell pipeline. Turning `ORBIT_AUTH_OIDC` back to `false` later
disables provider sign-in without deleting its configuration, so it can be
turned back on with no re-entry; see
[authentication.md](authentication.md#adding-oidc-later).

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
base `docker-compose.yml` without mail secret files.

**The mailbox is not container configuration.** Since ADR-0017 an instance
administrator sets it on the administration screen, and Orbit stores the
password encrypted in its own database under the document key. No `IMAP_*`
environment variable is accepted any more; a leftover one in `.env-orbit`
fails the configuration check as a removed key. Outbound SMTP is unchanged and
is still deployment configuration.

To configure inbound mail:

1. Configure SMTP first, and deploy the mail overlay so the SMTP password is
   mounted from `${ORBIT_SECRETS_DIR}/smtp-password`. Supply it from a secret
   manager or private editor, not a command argument. The path must be a
   non-empty regular file, not a symbolic link, and readable only by the
   deployment operator.

   ```sh
   docker compose --env-file .env-orbit \
     -f docker-compose.yml -f docker-compose.mail.yml config --quiet
   COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml \
     bash scripts/deploy-container.sh --pull
   ```

2. Sign in as an instance administrator, open **Administration → Mail
   machinery**, and enter the mailbox: host, port, account address, folder,
   TLS server name, provider profile, envelope-recipient header, poll seconds
   and the mailbox password.

3. Orbit connects to the provider and authenticates **before** it stores
   anything. A refusal leaves whatever was there untouched and stores no part
   of the password; only a successful check commits it.

Two things are derived from the account address and are not entered
separately: the collection domain, and the base local part every member's
relay address is built on. Relay addresses are plus-addresses of that account
(`account+<code>@domain`), so it must be an address the provider delivers
sub-addressed mail to.

The alias-derivation key is generated by Orbit at first setup, stored
encrypted alongside the password, and never shown to anyone — members
included. Changing the account address generates a new one, which changes
every member's relay address; correcting a host, port or folder does not.

**Forward, do not redirect.** The only supported way to use a relay address is
for a member to forward mail to it from their own mailbox. A redirect keeps the
original sender's address, so the message looks to Orbit as though somebody
else sent it, matches nobody, and is deleted. Handing a relay address to a
supplier, a bank or a web form is unsupported for the same reason. Tell members
this when you tell them the relay exists.

Orbit matches a forwarded message to a member by the address it was sent from,
and only when your provider's own check says that address is genuine. That
check is the `Authentication-Results` header your provider writes, and Orbit
has to know whose header to believe: that is the **trusted authserv-id** on the
mail settings screen. Gmail and Outlook are known, so leaving it blank works
for them. For Mailcow or any other provider it is your own mail server's
hostname — the name it writes at the start of that header — and until you fill
it in Orbit believes nothing, matches nothing to anybody, and says so on each
member's relay page. That is deliberate: guessing would be the guess an
attacker gets to use.

A message Orbit cannot match to a member is deleted from the mailbox, and
nothing is kept for you or anyone else to look at. The sender is told once, and
only when your provider vouched for them — never a mailing list, never an
autoresponder, never twice in a day, and never quoting what they sent.

Each member can also pause their own collection from the same page. While they
are paused, mail addressed to them is recorded as having arrived and nothing
else happens to it: no attachment is fetched, nothing is stored, and they are
not told. Turning it back on prepares everything that was waiting, once. A held
message expires on the same schedule as any other, after which it lives only in
the provider mailbox. One member pausing changes nothing for anybody else.

What you see of any of this is a count. The operations view reports how many
receipts sit in each state, including held and unattributed, and never whose
they are or what address they came to.

Members rotate their own relay address from their relay page, and one member
rotating changes nothing for anybody else. The one exception is an emergency:
an administrator can replace the alias key for the whole instance, which
changes every member's address at once. Choose how long the old addresses keep
collecting — anything from none at all up to 90 days — and mail already on its
way arrives at the old address until that runs out. Everything else about
rotation belongs to the member, not to you: you can see that a rotation
happened and who did it, never the address itself.

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
| `credential_locked` | The stored credential could not be decrypted under the current key (ADR-0017); polling is stopped until an administrator re-enters it. |
| `retrying` | A content-free notification is waiting for bounded retry. |
| `exhausted` | A content-free notification reached its attempt limit. |
| `retention_backlog` | Private staging cleanup needs operator attention. |

Verification and retry actions require an authenticated instance
administrator, same-origin CSRF proof, and non-cacheable responses. They never
return recipients, aliases, filenames, message or document content, hashes,
storage identifiers, credentials, or raw provider errors. Administrator
authority does not grant access to a user's private receipt, draft, staged
attachment, or authenticated review page.

What the mailbox settings screen shows, and only this: host, port, account
address, folder, TLS server name, provider profile, envelope-recipient header,
poll seconds, verification state and time, who set the credential and when,
the *shape* relay addresses take, and the bounded health words above. It never
shows the mailbox password, the alias key, or any member's relay address —
none of which has a read path at all.

Mailbox notifications are durable, leased, idempotently materialized, and
bounded on failure. Their generic body contains no source content and links
only to `/?open=inbox` on the configured HTTP(S) application origin. The link
still requires authentication and cannot approve, attach, or write anything.
SMTP remains at-least-once: if a provider accepts a message immediately before
Orbit loses its completion update, an explicit retry can duplicate the generic
notification. The interface warns before retrying exhausted deliveries.

### Disable, restart, and credential rotation

All of these are actions on the administration screen. None needs a redeploy,
and none is a container setting.

- **Pause ingest** stops new polling and preserves everything: the mailbox
  cursor, receipts, private drafts and staging are untouched, exactly as the
  old `IMAP_ENABLED=false` preserved them. Resume picks up from the durable
  cursor.
- **Check connection** re-runs the bounded TLS and authentication check
  against the stored credential and records the outcome as a bounded word.
- **Run setup probe** sends one message from the instance to a derived
  plus-address of the mailbox and watches for it to come back. It answers
  `delivered` when the message arrived with its envelope recipient intact —
  the only state in which mail can be attributed to a member — and separates
  the two ways it can fail: `delivered_without_recipient_header` means the
  provider delivers sub-addressed mail but strips the envelope recipient, and
  `not_delivered` means it does not deliver it at all. Orbit removes its own
  probe message from the mailbox.
- **Rotate password** takes the new password, proves it against the provider
  first, and only then swaps it in. The new encrypted row becomes active and
  the old one is deleted in the same transaction, so a rotation never leaves a
  spent credential behind and a refused one leaves the previous password
  working.
- **Remove credential** deletes the stored password and switches ingest off.
  The host, account and folder stay, and so do the cursor, receipts, drafts
  and staging.
- A routine restart re-verifies the current provider commitment before polling
  and resumes through the durable cursor and leases. Re-enabling after a
  restart or provider outage uses the preserved cursor and receipt identities;
  it must not create a second draft or delivery operation for already recorded
  mail.
- Rotate SMTP independently by replacing its host secret file atomically and
  restarting the exact deployed image. Never place a credential in a command,
  screenshot, issue, log, or acceptance record.

If the document key is replaced **without** rewrapping — a recovery-bundle
import, or repair regenerating `document-kek` when no document volume is
retained — the stored mailbox credential can no longer be decrypted. Mail-in
reports `credential_locked`, polling stops, and an administrator re-enters the
password on the same screen. A mailbox password is re-obtainable from the
provider; documents and encrypted metadata are not, which is why this degradation
is acceptable for those two paths specifically: both are a wholesale key
*replacement*, not a rotation, and neither carries the old key forward for a
rewrap to use. An ordinary planned rotation is different — see "Rotating the
document key-encryption key" below — and leaves every credential, document and
encrypted metadata field readable throughout.

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

## Rotating the document key-encryption key

`DOCUMENT_KEK` wraps three populations: document encryption keys
(`document_crypto`), the per-household metadata keys that cover both Tier 1 and
Tier 2 (`metadata_keys`, ADR-0024), and the mail-in mailbox credential and alias key (`mail_in_secrets`,
ADR-0017). Rotating it is always an operator decision (#932) — nothing in
Orbit rotates it automatically or on a schedule.

Rotation is genuinely online: for its duration the running application holds
**both** the current key and the next one (`DOCUMENT_KEK_NEXT`, #954,
ADR-0024 decision 4), so every row stays readable by its own stored key id
regardless of whether the rewrap worker has reached it yet. No row is ever
unreadable, and no maintenance window is needed at any step below.

1. Generate a fresh key and place it where the rotation overlay expects it,
   with owner-only permissions:
   ```sh
   openssl rand -hex 32 > .orbit-secrets/document-kek-next
   chmod 0400 .orbit-secrets/document-kek-next
   ```
2. Give the running application the next key *before* rewrapping anything,
   using the `docker-compose.kek-rotation.yml` overlay:
   ```sh
   docker compose --env-file .env-orbit \
     -f docker-compose.yml -f docker-compose.kek-rotation.yml config --quiet
   COMPOSE_FILE=docker-compose.yml:docker-compose.kek-rotation.yml \
     bash scripts/deploy-container.sh --pull
   ```
   After this restart Orbit holds both keys: every existing row is still on
   the current key and reads exactly as before, and a row the worker moves to
   the next key from here on reads too, by its own key id, with nothing
   locked at any point in between. From this restart anything newly written —
   an uploaded document, a new household's metadata key, a mailbox credential —
   is wrapped under the **next** key straight away (#955), so the rewrap in
   step 3 is chasing a fixed set of rows rather than a moving one.

   From this restart the rotation is also visible until step 4 removes the
   second key (#956): Orbit records one instance-level
   `document_kek_rotation_started` audit entry naming both key ids — one per
   rotation, however many restarts happen inside it — every startup logs a
   `document.kek_rotation` line saying a rotation is in progress and for how
   long, and the administration screen shows a "Document key rotation in
   progress" card with how long it has been open. Orbit never refuses to
   start over a long-open rotation — that would turn a slow rotation into an
   outage — so this visibility is the whole guard: if the card or the log
   line is still there tomorrow, the rotation was left unfinished, not
   handled.
3. Run the rewrap worker. It reads the current key exactly as the running
   application does, and takes the next key only from the file you give it:
   ```sh
   pnpm rewrap-kek --next-key-file .orbit-secrets/document-kek-next
   ```
   It reports progress and keeps going until every `document_crypto`,
   `metadata_keys` and `mail_in_secrets` row is wrapped under the next key,
   resuming correctly if you stop it (Ctrl-C, a crash, a host reboot) and run
   it again — every row it has not yet reached is still fully readable under
   the current key, and every row it has already moved is fully readable
   under the next one; a batch is one transaction, so a row is never left
   half-migrated, and step 2 means both states read successfully the whole
   time. It records one `document_kek_rotation_completed` audit entry when it
   finishes.
4. **The point of no return.** Only once the worker reports completion,
   promote the next key to current and drop the overlay:
   ```sh
   mv .orbit-secrets/document-kek-next .orbit-secrets/document-kek
   bash scripts/deploy-container.sh --pull
   ```
   Read this step as a confirmation. Everything before it can be undone.
   This move overwrites the outgoing key, and after it that key is gone: no
   row is wrapped under it any more, nothing needs it, and it cannot be used
   to read anything ever again. That is deliberate — a rotation you are
   running because a key may have leaked has not achieved much if the leaked
   key is still sitting in `.orbit-secrets/` beside its replacement.

   Orbit derives `DOCUMENT_KEK`'s id from the key bytes themselves, so this
   restart always finds every row already on the key it just loaded as
   current — nothing needs to know the id in advance. Dropping the overlay
   (by deploying with just `docker-compose.yml` again) removes
   `DOCUMENT_KEK_NEXT`; with the rewrap already complete, no row depended on
   it being there.

### If you are rotating because a key may have leaked

The exposed key stays live, and stays able to read everything, until step 4.
The exposure ends there, not at step 1. So run the steps together rather than
leaving a rotation part-done overnight.

Rotation also does not un-read anything already copied. It stops the exposed
key being useful against this instance from step 4 onward; it does not undo a
copy someone took before you started.

### Undoing a rotation, before step 4 only

Going back is not a rollback — there is nothing to roll back. It is a
rotation in the other direction, from the new key to the original one, and it
is available only while both keys are still loaded. After step 4 the original
key no longer exists, so there is no way back and you should not plan for one.

To undo, swap which key is which and run the same steps again:

```sh
mv .orbit-secrets/document-kek       .orbit-secrets/document-kek-abandoning
mv .orbit-secrets/document-kek-next  .orbit-secrets/document-kek
mv .orbit-secrets/document-kek-abandoning .orbit-secrets/document-kek-next
```

Then repeat steps 2, 3 and 4. Nothing is unreadable at any point of it: the
instance holds the same two keys throughout, and every row reads under
whichever of them wrapped it. Step 4 finishes by overwriting the abandoned
key, which is what you want — a spare key left lying in `.orbit-secrets/` is
one a later rotation can pick up by mistake, and this instance has already
written rows under it.

If you copied that key anywhere else — a password manager, a note, a backup
of the secrets directory — delete it there too. Removing the file on this
host is not the same as the key being gone.

Recovery-bundle import and repair's `document-kek` regeneration remain
wholesale key *replacements*, not rotations: neither carries the old key
forward for a rewrap, so they still leave existing documents, encrypted metadata
and the mailbox credential unreadable under the new key (the paragraph above
this section).

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

## Private model server and its model pull

The default stack does not start the `ai` profile. An operator who leaves it off
gets no model server, no pull helper, and no change of any kind.

Where the profile is on, the model server runs on the same egress-denied network
as the document parser, and its port is not published to the host. This is
deliberate and structural: the container that would hold document text has no
route to the internet, so it cannot become a way out for household documents,
whatever image or model is loaded into it. The address Orbit would use is fixed
in the application code, so there is no base URL, proxy setting or API key to
configure, and therefore no configuration that could aim extraction at a hosted
service. Do not give this service the default network, a second network or a
published port; the Compose validation refuses the configuration if you do.

### Pulling a model

Because the server has no route out, it cannot download a model. Getting one in
is a separate step that an operator runs by name — it never happens as a side
effect of starting the stack. Set the model reference in `.env-orbit` first. A
digest-pinned reference is recommended, so that a later pull fetches the model
that was actually evaluated rather than whatever the tag points at that day:

```sh
# .env-orbit
OLLAMA_MODEL=<model>@sha256:<digest>
```

Then check the resolved configuration and run the pull. It downloads into the
`orbit-ollama-data` volume and exits:

```sh
docker compose --env-file .env-orbit --profile ai-model-pull config --quiet
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm orbit-ollama-model-pull
```

Start the server once the pull has reported success:

```sh
docker compose --env-file .env-orbit --profile ai up -d orbit-ollama
```

Run the pull again whenever the model reference changes. The pull helper is the
only part of this stack that reaches the internet for model data, it runs only
for as long as your command runs, and it never receives document text.

### Hosts with no direct internet access

The pull helper needs outbound access to the model registry, so on an isolated
host it cannot fetch anything. Two options, in order of preference:

1. Allow the host outbound access, or point the Docker daemon at an HTTP proxy,
   for the length of the pull only, then take it away again. The model server
   is unaffected either way: the access belongs to the host and to the one-shot
   pull container, never to the service Orbit talks to.
2. Carry the model in from a machine that does have access. Run the pull there
   against the same compose file, export the model volume, and import it on the
   isolated host. Only model data moves; no household data is involved.

```sh
# on the connected machine, after the pull above has succeeded
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm --entrypoint /bin/sh -v "$PWD:/export" orbit-ollama-model-pull \
  -c 'tar -C /root/.ollama -czf /export/orbit-model.tar.gz .'

# on the isolated host, with the ai profile stopped
docker compose --env-file .env-orbit --profile ai-model-pull \
  run --rm --entrypoint /bin/sh -v "$PWD:/import" orbit-ollama-model-pull \
  -c 'tar -C /root/.ollama -xzf /import/orbit-model.tar.gz'
```

Transfer the archive between the two machines by whatever means the site already
trusts. Then confirm the server can see the model:

```sh
docker compose --env-file .env-orbit --profile ai up -d orbit-ollama
docker compose --env-file .env-orbit --profile ai exec orbit-ollama ollama list
```

To stop using the model server, stop the profile. Nothing else changes:

```sh
docker compose --env-file .env-orbit --profile ai stop orbit-ollama
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
