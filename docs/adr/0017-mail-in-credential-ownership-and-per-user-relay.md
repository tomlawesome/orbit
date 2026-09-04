# ADR-0017: Mail-in credential ownership and per-user relays

**Status:** Accepted (owner, 2026-09-02, #336)
**Date:** 2026-09-02
**Relates to:** issue #336 (per-user inbound mail; owner rulings of
2026-08-13 and 2026-09-02 are the ratified frame for this record);
[ADR-0005](0005-reviewed-ingestion-and-mailbox-staging.md) (reviewed
ingestion, alias scheme, rotation contract — amended here);
[ADR-0004](0004-supported-upgrades-and-recoverable-restore.md) (restore
contract the credential must survive);
[ADR-0013](0013-maintenance-mode-state-and-interception.md) (versioned
singleton + same-transaction audit pattern reused here); #432 (relay page
read-only slice), #298 (mail-in module split), #411 (bounded relay words)

## Context

The owner ruled on 2026-08-13 (#336 comments): pull-only, no listening; ONE
admin-owned mailbox; per-user relay addresses are plus-addressed aliases of
that mailbox under the existing HMAC scheme; Orbit sorts locally by alias into
each user's private review queue; SMTP stays as it is; providers Mailcow,
Gmail, Outlook with password auth first and XOAUTH2 later; the degradation
ladder; and the alias-prefix case-fold. On 2026-09-02 the owner replaced the
ladder's lower rungs: attribution is by the sender's verified address, the
only supported use is a member forwarding from their own mailbox, and mail
that matches nobody is answered and deleted rather than kept for anyone.
None of that is reopened here. This record decides what was left open: how
the single credential is stored and audited once it leaves the container
environment, how alias-generation state becomes per-user, how a message is
attributed to a member and what happens when it cannot be, whether
household-level relays exist, the threat-model addendum, the upgrade path,
and the delivery slices.

Where the code stands today:

- The mailbox credential and alias secrets are runtime secrets read from the
  environment or `_FILE` mounts (`src/server/mail-in/core/config.ts:117-182`),
  supplied by the optional overlay `docker-compose.mail.yml:1-19` from
  `.orbit-secrets/imap-password` and `.orbit-secrets/imap-alias-current-secret`.
- Alias rotation is instance-wide: one current and at most one previous
  generation, from environment (`config.ts:130-160`), reconciled against a
  database singleton `imap_recipient_rotation_state` (`src/db/schema.ts:595-608`)
  by the state machine in `src/server/mail-in/core/imap-rotation.ts:57-110`.
  Its "commitment" digests exist only to detect environment drift against the
  database authority.
- Lookup filters alias digests by the instance's generations
  (`src/server/mail-in/imap-ingestion.ts:327-337`) and reconciliation
  materialises every user's rows from the instance key
  (`imap-ingestion.ts:247-311`).
- The relay page reads the instance `IMAP_ENABLED` flag as a stand-in for a
  per-user pause and never takes a user id from the request
  (`src/server/mail-in/relay-settings.ts:13-15, 40-41, 66-92`).
- Documents and mail-in staging already envelope-encrypt under one
  file-mounted KEK (`src/server/documents/crypto.ts`,
  `src/server/documents/config.ts:59-86`,
  `src/server/mail-in/imap-attachment-holding.ts:29-69`).
- No live KEK rewrap exists: `rewrapDocumentKey` (`crypto.ts:167-184`) has no
  production caller; the only KEK replacement path is a wholesale swap by
  `import-recovery-bundle` (`src/cli/orbit.ts:362`).
- The alias local part is the literal `orbit+<token>` (`core/imap-recipient.ts:27, 47`).

## Decision

### 1. One app-managed mailbox credential under the document KEK

**Tables.** Two new tables, following the `instance_maintenance` shape
(`schema.ts:184-192`: `singleton` PK, `id uuid`, `version`, same-transaction
audit):

- `mail_in_mailbox` (singleton): non-secret provider configuration — host,
  port, account user, mailbox folder, TLS server name, provider profile
  (`mailcow` | `gmail` | `outlook` | `other`), auth method (`password` now;
  `xoauth2` later), trusted envelope-recipient header, poll seconds,
  `enabled`, verification state and time, `version`, audit columns. The
  recipient domain and the alias *base local part* are derived from the
  account address, not configured separately (see "Alias shape" below).
- `mail_in_secrets`: one row per secret — `id uuid`, `kind`
  (`imap_password` | `alias_key`; `oauth_refresh_token` reserved for the
  XOAUTH2 slice), `ciphertext bytea`, and the envelope columns exactly as
  `document_crypto` (`schema.ts:327-339`): `envelope_version`, `content_iv`,
  `content_auth_tag`, `wrapped_dek`, `wrap_iv`, `wrap_auth_tag`, `key_id`;
  plus `created_by_user_id`, audit columns. The active row per kind is
  referenced from `mail_in_mailbox` (`password_secret_id`,
  `alias_key_secret_id`); a superseded row is deleted, not kept.

**Key hierarchy.** Unchanged root: the document KEK from
`.orbit-secrets/document-kek`, staged to `/run/orbit-secrets/orbit-document-kek`
by `scripts/container-entrypoint.sh:74-132`, read by
`getDocumentConfig()` (`documents/config.ts:59-65`), `keyId` derived at
`config.ts:85`. Below it, per secret row: a fresh random 32-byte DEK wrapped
under the KEK with AES-256-GCM, and the secret bytes encrypted under the DEK
with AES-256-GCM. The DEK exists only wrapped in its row and unwrapped in
process memory for the duration of one use, then zeroed — the discipline
`crypto.ts:139-141, 161-163` already applies. Implementation generalises the
two AAD builders in `crypto.ts:48-67` with a new purpose rather than adding a
cipher construction: key-wrap AAD `{purpose: "orbit-mail-in-secret-dek",
envelopeVersion, secretId, keyId}`; content AAD `{envelopeVersion, secretId,
kind, host, user}` so a row cannot be re-pointed at a different account or
kind without failing authentication.

**Why the document KEK and not a second KEK.** Mail-in already cannot stage an
attachment without it (`imap-attachment-holding.ts:29-69`); a second key buys
no isolation and doubles the key-loss story (`docs/document-threat-model.md:278-298`).

**Credential rotation.** An instance administrator submits a new password;
Orbit verifies it against the provider with the existing bounded connect
(`imap-ingestion.ts:1000-1011`) *before* committing; on success the new
`mail_in_secrets` row becomes active and the old row is deleted in the same
transaction. A failed verification leaves the old credential active and
records nothing secret. Removal clears the reference, deletes the row and
sets `enabled=false`; cursor, receipts, drafts and staging are preserved, as
`IMAP_ENABLED=false` preserves them today (`docs/administrator-operations.md:309-310`).

**KEK rotation.** There is no live rewrap today. The contract: any future
rewrap command must rewrap every `mail_in_secrets` row (selected by `key_id`)
in the same transaction as `document_crypto`. Until one exists, a KEK swap
(recovery-bundle import, or repair's `regenerate-secret` for `document-kek`,
ADR-0014 slice 3) makes the rows unreadable. Startup and each poll cycle
therefore verify decryptability first; failure puts mail-in in a new
operator state `credential_locked` (added to the table at
`administrator-operations.md:278-291`), stops polling, and the administrator
re-enters the credential. This degradation is acceptable because a mailbox
password is re-obtainable from the provider; documents are not.

**Audit events.** Vocabulary matches the existing instance-level rows
(`householdId: null`, entity + past-tense action, small non-secret `changes`;
e.g. `src/server/admin-repository.ts:353-364`). Entity `mail_in_mailbox`,
entity id = the singleton's `id`:

- `mail_in_credential_created`, `mail_in_credential_rotated`,
  `mail_in_credential_removed` — `changes: { kind, keyId }`;
- `mail_in_credential_imported` — the one-shot upgrade import,
  `actorUserId: null`, `changes: { source: "environment", kinds }`;
- `mail_in_credential_verified` (`changes: { outcome }`, bounded class only)
  and `mail_in_credential_locked` (decrypt failure, `changes: { keyId }`);
- `mail_in_ingest_enabled`, `mail_in_ingest_disabled`;
- `mail_in_alias_key_rotated` — the instance-wide emergency rotation in
  decision 2, `changes: { users, graceUntil }`.

**What an administrator sees.** Host, port, account user, folder, TLS name,
provider profile, verification state and time, who set the credential and
when, and the bounded health classes already exposed by
`src/server/admin-operations.ts:222-240`. Never: the password or alias key
(write-only fields; no read endpoint returns them; not in the portable
archive, logs, audit `changes`, or error text — the
`ImapRotationStaleError` rule at `core/imap-rotation.ts:23-31` is the
precedent), any user's alias address (the database holds digests only,
`relay-settings.ts:3-8`), any draft or staged byte (unchanged).

**Restore from backup.** The rows ride in `database.dump`
(`scripts/backup.sh:113-115`); the plaintext KEK is never in the bundle
(guarantee at `docs/installer-guarantees.md:412-413`). Restore refuses a
local KEK whose fingerprint differs from the manifest's
(`installer-guarantees.md:575, 583`; asserted by
`scripts/test-backup-restore.sh:451-462`), so a restore that succeeds always
brings back a decryptable credential, by construction. Disaster recovery via
the recovery bundle carries the KEK itself (`src/lib/recovery-bundle.ts:139-227`)
and reaches the same state. After restore, polling resumes from the durable
cursor; receipts stay idempotent on mailbox/UIDVALIDITY/UID
(`schema.ts:546`). A restored *copy* of an instance polls the same mailbox —
true today of any environment-configured clone and unchanged by this record;
the restore documentation must say so.

### 2. Per-user alias generations, pause, and the sibling invariant

**Alias shape.** Aliases become plus-addressed spellings of the one account,
as ratified: `<account-local>+<token>@<account-domain>`. The literal `orbit+`
prefix in `ALIAS_LOCAL_PART` and `deriveImapRecipientAlias`
(`core/imap-recipient.ts:27, 47`) becomes the account's local part, derived
from `mail_in_mailbox`; token derivation and the case-insensitive match
(`imap-recipient.ts:19-27`, landed in `98f59dd`) are unchanged. Mailcow
catch-all or custom aliases remain an operator option, not a requirement.

**Per-user state.** The singleton `imap_recipient_rotation_state` is retired.
New table `mail_in_relays`, one row per user (`user_id` PK):
`current_generation` (> 0), `previous_generation` and `previous_expires_at`
(nullable, paired as `imap_recipient_rotation_state_previous_pair` pairs them
today, `schema.ts:607`), `ingest_paused_at`, `rotated_at`, `version`, audit
columns. `imap_recipient_aliases` (`schema.ts:579-592`) stays the lookup index
and gains `alias_key_secret_id`, recording which instance alias key derived
each row. The instance alias key itself is one `mail_in_secrets` row of kind
`alias_key`, generated by Orbit at first setup or imported on upgrade;
users never hold or see it.

**Generation contract, per user.** Exactly one current generation; at most
one previous, with an explicit expiry. Generations are a per-user monotonic
counter — never lowered, never reused, meaningful only within that user's
row. `rotate`: previous (if any) → `legacy_inactive` now; current → previous
with `previous_expires_at = now + 14 days`; new current = old current + 1,
materialised immediately as an `active` alias row. `rotate and cut off`:
the same with expiry `now`. Expiry is fixed by the product, not chosen by
the user; the 90-day cap (`config.ts:80`) remains the ceiling for the
administrator-only key rotation below. Every transition is
`UPDATE mail_in_relays … WHERE user_id = $self AND version = $expected`.

**Lookup.** `userForRecipientAlias` (`imap-ingestion.ts:313-351`) drops the
instance-generation filter at line 336: it selects rows by digest where
`status = 'active'` and `active_until` is null or future, then verifies the
HMAC with the key named by the row's `alias_key_secret_id`, the row's
generation and the row's user. Failure codes (`recipient_alias_expired`,
`recipient_unverified`, `recipient_disabled`, `recipient_alias_ambiguous`)
keep their meanings. `reconcileImapRecipientAliases`
(`imap-ingestion.ts:247-311`) shrinks to enrolling new users at generation 1
and expiring previous rows; `core/imap-rotation.ts` and its stale-error class
are removed with the singleton, since the environment is no longer a second
authority to reconcile against.

**Pause.** `ingest_paused_at` set on the user's row. At receipt time, a
message resolved to a paused user is recorded with a new
`imap_ingestion_status` value `held` (`schema.ts:32-42`): content-free, no
attachment downloaded, no staging, no notification. Resume flips that user's
`held` rows to `processing` with `attachment_processing_next_attempt_at =
now`; the existing exact-UID retry pass (`imap-ingestion.ts:839-847, 899-901`)
fetches and stages them. A `held` receipt expires with the ordinary
`expires_at` (30 days) and the message then lives only in the provider
mailbox. Skipping paused mail without a receipt was rejected because the
cursor is `max(uid)` (`imap-ingestion.ts:848-853`): a skipped UID would never
be revisited. Attribution by sender (decision 3) is subject to the same
pause.

**Sibling invariant.** A user-initiated rotate, cut-off, pause or resume
touches only rows whose `user_id` is the session's own user; no statement on
that path has a wider predicate, and the route continues to take no user
identifier from the request (`relay-settings.ts:13-15`). The instance alias
key never changes on a user action. The only operation that changes every
user's address is the administrator's emergency `mail_in_alias_key_rotated`:
a new `alias_key` row, then every user rotated in one transaction with a
grace expiry the administrator sets (0 to 90 days). Acceptance for the
per-user slice is a test with two users where rotating and pausing A leaves
B's rows and derived address byte-identical and B's mail still processed.

**Audit and visibility.** Entity `mail_in_relay`, entity id = the user's id,
`householdId: null`, actor = the user: `mail_in_relay_rotated`
(`changes: { fromGeneration, toGeneration, previousExpiresAt }`),
`mail_in_relay_paused`, `mail_in_relay_resumed`; addresses and digests never
appear in `changes`. Per-user `last_received` and pause state are the user's
own (`relay-settings.ts:80-91`). The administrator surface shows aggregate
counts per receipt status (including `held`) and never a per-user address.

### 3. Attribution by verified sender, and one supported path

Owner ruling of 2026-09-02 (#336). It replaces rungs 2–3 of the 2026-08-13
degradation ladder (sender-address fallback, then unattributed mail held for
someone to sort out).

**One supported path.** A member forwards mail from their own mailbox to
their own relay address. Giving a relay address to a third party — a
supplier, a bank, a web form — is unsupported: the relay page and the user
documentation say so plainly and give the reasons (the address is personal
and rotates; many web forms reject `+` addresses; third-party mail cannot be
matched to a member by sender, so it is deleted under this decision). Orbit
does not design for that traffic. **Forward only, said loudly** (owner,
2026-09-02): a redirect keeps the original sender's address, and the
provider's authentication check fails against that sender, so a redirected
message matches nobody and is deleted. The relay page carries this next to
the address itself — not in a help link — and the user documentation leads
its mail-in section with it, with a screenshot of the forward action in each
supported client. The reply sent for unattributed mail names redirect as the
likely cause.

**Every member has verified sending addresses.** New table
`mail_in_sender_addresses`: `user_id`, `address` (normalised: trimmed,
case-folded, one row per address), `source` (`account` | `sso` | `manual`),
`verified_at`, `verification_token_digest`, `verification_expires_at`,
audit columns; unique on the normalised address across the instance, because
one address attributes to exactly one member. Orbit seeds an unverified row
from the local account's email or the OIDC `email` claim and shows it on the
relay page with an override box; the member may add further addresses they
send from. No address attributes anything until verified: Orbit sends a
one-use link over the existing SMTP path (the notification sender in
`src/server/notification-worker.ts`), the member opens it, `verified_at` is
set. Until a member has at least one verified address the relay page shows
the relay as not yet usable and explains why, and their mail takes the
unattributed path below.

**Attribution rule.** At receipt, the `From` address is normalised and
looked up among verified rows; the member it names owns the message. The
plus-address alias (decision 2) corroborates rather than attributes: absent,
expired or malformed, the message still belongs to the matched sender; naming
a *different* member, the message is unattributed. A sender address is
believed only when the account's own provider vouches for it: the topmost
`Authentication-Results` header written by that provider (Mailcow, Gmail and
Outlook all write one; the trusted authserv-id is part of the provider
profile in decision 1) must report `dmarc=pass`, or `dkim=pass` with the
signing domain aligned to the sender domain. Absent or failing, the message is
unattributed — a `From` header is otherwise anyone's to write. The receipt
records `attributed_by` (`sender` | `sender_and_alias`) so the review queue
can label how it arrived.

**The alias code stays random.** A memorable code (`family+sarah@`) lets
anyone post into a member's queue with no forgery needed. Nobody types it:
the relay page offers copy-to-clipboard and the member saves it as a contact.

**Unattributed mail is answered and deleted.** A message that matches no
verified sender gets a content-free receipt with new status `unattributed`
(added to `imap_ingestion_status`, `schema.ts:32-42`; no attachment
downloaded, no staging, no notification), Orbit sends one reply to the
sender saying the message was not matched to a member and has been deleted,
and what to do (verify the address on the relay page, or forward rather than
redirect), then flags the message `\Deleted` and expunges that UID from the
mailbox. Nothing is kept for an administrator or anyone else; the relay
health line shows the count. Conditions on the reply, so that it cannot be
turned against the household mailbox: reply only when the provider's
authentication result passes for the sender, so a forged `From` never earns a
reply to an innocent third party; never reply to automated mail
(`Auto-Submitted` other than `no`, `Precedence: bulk`/`list`/`junk`, a
`List-Id`, or an empty return path); at most one reply per sender address per
day; never quote the original. Where the reply is suppressed the message is
deleted silently and counted all the same.

### 4. No household-level relay addresses

The open sub-decision — "whether shared-household mailboxes remain alongside
per-user relays" — was framed when each user might have had a mailbox of
their own. Under the ratified architecture the one admin-owned mailbox *is*
the shared household mailbox, and the residual question is whether a
household also gets a relay address of its own, delivering into a queue its
members share. **Decided: no.** One relay address per user; households are
chosen at review, as now (`imapIngestionMessages.householdId` is null at
receipt, `imap-ingestion.ts:868`).

Reasons: a shared queue is household-visible state created by receipt alone,
which is exactly what ADR-0005 rejected (its "hidden archived household item"
alternative). Approval needs an accountable actor and a private draft
(`reviewed-intake` re-authorises the user and destination); a queue with N
readers has neither. A household address is a capability held by N people,
so rotating or pausing it affects siblings by construction — the invariant
in decision 2 cannot hold for it. And the user outcome is already available:
a member forwards the mail from their own mailbox and files the result to
the household at review. A future ADR may add household addresses
that fan out into per-member private drafts; that is not this record.

### 5. Threat-model addendum

Extends `docs/document-threat-model.md` §"Planned v1 intake extensions".

- **A sender address is a claim, not a credential.** Attribution by sender
  (decision 3) would otherwise let anyone who knows a member's email address
  post into that member's queue by writing it in `From`. Requiring the
  provider's own authentication result, and answering only authenticated
  senders, closes both that and the backscatter path in which a forged
  `From` makes Orbit email a stranger. Verification before an address
  attributes anything stops one member claiming another's address to receive
  their forwarded documents. What remains is bounded as before: a genuine
  sender can only fill the queue of the member they are, or that the alias
  names, within the existing size and count limits.

- **The mailbox is the trust boundary.** Everything inside it is hostile
  input; Orbit authenticates to the provider with the one credential.
  Compromise of that credential is provider-side read access to every
  user's inbound mail — unchanged from the environment-configured design,
  and the reason the credential is admin-owned, write-only, envelope-
  encrypted, rotatable, and never per-user.
- **Hostile-ingest surface per user.** Each alias is a capability
  (`relay-settings.ts:3-8`): whoever holds it can fill that user's private
  queue within the existing bounds (25 MiB raw, 25 messages per poll,
  30-day expiry). The mitigations are the user's own rotate, cut-off and
  pause, isolated per decision 2. Alias leakage harms one user only.
- **Reviewed-ingestion boundary, per user.** Unchanged: nothing becomes an
  item or attachment without that user's explicit approval. Pause, resume,
  rotate and the credential lifecycle cannot create, alter or delete an
  item; `held` receipts hold no bytes.
- **What an instance administrator can observe.** Non-secret provider
  configuration, verification and health classes, aggregate receipt counts,
  and the audit trail of relay and credential events (actions and user ids,
  no addresses). **Cannot:** the password or alias key, any user's alias,
  drafts, staged bytes, or per-user activity — the existing rule at
  `administrator-operations.md:292-297`. An administrator can always read
  the mailbox at the provider directly; envelope encryption protects the
  credential against a copied database or backup without the KEK, not
  against the administrator who set it.
- **Secrets never appear** in logs, audit `changes`, API responses, exports
  or error text. The unwrapped credential is held only for the connect and
  zeroed after.

### 6. Migration from container-environment configuration

**What an existing install experiences.** On first start after upgrade, if
the environment holds a complete IMAP configuration
(`getImapIngestionConfig().configured`, `config.ts:123-126, 162`) and
`mail_in_mailbox` has no row, Orbit imports once, under a row lock and only
when the KEK is readable: non-secret values into `mail_in_mailbox`; the
password and current alias secret (and the previous tuple, if unexpired)
into `mail_in_secrets`; and every user's row in `mail_in_relays` from the
singleton's current/previous generations, so **no user's address changes on
upgrade**. The import writes `mail_in_credential_imported` and is never
repeated. From then on IMAP environment values are ignored; the operator
surface shows `environment_configuration_ignored` until they are removed.
This is an application startup step, not a SQL migration, because it needs
the KEK.

**What install-time guarantees change.** `docker-compose.mail.yml` drops
`IMAP_PASSWORD_FILE` and `IMAP_ALIAS_CURRENT_SECRET_FILE` and the
`docker-compose.mail-alias-rotation.yml` overlay is retired
(`administrator-operations.md:323-341`). SMTP entries are untouched.
`scripts/configuration.sh` keeps every `IMAP_*` key in `allowed_keys`
(line 35) but classifies all of them `deprecated_supported` (extending
guarantee #4, `installer-guarantees.md:66`); a later release moves them to
`removed_keys` (guarantee #3). Readiness stops requiring IMAP values
(`scripts/configure.sh:1067-1094`, `src/lib/config-contract.ts:460-486`):
the `imap` optional service reports `app-managed`. Nothing in the installer
generates or reads a mailbox secret any more; guarantee catalogue entries
change in the same pull request as the code, per that document's rule.

## Consequences

- Mail-in configuration becomes a product surface with audit, verification
  and rotation in the application, matching ADR-0011's direction; the
  installer's mail surface shrinks to SMTP.
- The alias scheme's authority moves wholly into the database; the
  drift-detection machinery in `core/imap-rotation.ts` and the
  characterisation tests that pin it (`src/server/imap-characterization.test.ts`)
  are retired with it, deliberately.
- Existing installs keep their addresses across the upgrade, at the cost of
  a one-shot import that needs the KEK at startup; the credential inherits
  the KEK's loss story, and any future rewrap command owns these rows too.
- ADR-0005's "administrator-selected transition" for rotation is amended:
  transitions are per-user and fixed at 14 days; the administrator retains
  only the instance-wide emergency rotation.
- `held` and `unattributed` are new receipt statuses every reader of
  `imap_ingestion_status` must handle (review inbox, operator counts,
  expiry).
- Mail-in gains its first two outbound and destructive actions on the
  mailbox: a reply to an unknown sender, and deletion of the message. Both
  are bounded by decision 3's conditions and both need the mailbox
  credential to carry delete rights, which password authentication already
  gives.
- ADR-0005's quarantine remains for messages that *were* attributed but
  failed validation; a message nobody owns never reaches quarantine now.
- Relay usability depends on a verified sending address, which depends on
  working SMTP: an instance without SMTP cannot verify addresses and so
  cannot attribute mail. The relay page says so rather than failing quietly.

### Delivery: implementation slices, in order

1. **App-managed mail-in secrets** — `mail_in_mailbox` and `mail_in_secrets`
   migrations; crypto purpose variant with AAD as in decision 1; startup
   decryptability check and `credential_locked`; the one-shot environment
   import; audit events; `getImapIngestionConfig` reads the database and
   falls back to nothing. *Accept:* envelope tests for round trip, AAD
   mismatch, wrong KEK, corrupt tag; import is idempotent and preserves every
   user's derived address; a wrong-KEK start reports `credential_locked`
   without a stack trace or secret in logs; backup/restore harness
   (`scripts/test-backup-restore.sh`) proves the credential decrypts after
   restore.
2. **Administrator mailbox settings surface** — set, verify, rotate, remove,
   enable/disable on the admin API and `admin-manager.tsx`; password
   write-only; provider profile; alias base derived from the account
   address; setup probe that round-trips a self-addressed message to a
   derived alias (ratified ladder, rung 1); compose overlay, `configuration.sh`
   classification, readiness and `docs/administrator-operations.md` updated;
   guarantee catalogue entries in the same PR. *Accept:* no response, log or
   audit row contains a secret; verification failure leaves the previous
   credential active; catalogue and docs match the scripts.
3. **Per-user relay generations** — `mail_in_relays`; lookup by row; rotate
   and cut-off on `PUT /api/settings/mail-relay`; the relay page's
   `rotate address` control; the `mail_in_relays` part of decision 6's
   import (every user's row from the singleton's generations — slice 1
   imports only the mailbox and secrets, and addresses survive it because
   the alias key bytes and the singleton are unchanged until here); retire
   the singleton and `core/imap-rotation.ts`; administrator
   `mail_in_alias_key_rotated`.
   *Accept:* sibling test from decision 2; previous alias attributes until
   expiry and `recipient_alias_expired` after; generation never reused;
   route still takes no user id.
4. **Verified sender addresses and attribution** —
   `mail_in_sender_addresses`; seeding from the account or SSO claim; the
   relay page's address list with override, add, remove and verification
   state; the verification mail and one-use link; the receipt-time
   attribution rule with the `Authentication-Results` check and
   `attributed_by`; the `unattributed` status, the bounded reply and the
   delete-and-expunge; the relay page and user docs carrying the one
   supported path and the forward-not-redirect note; relay health count.
   *Accept:* with two members A and B, A's forwarded mail with no alias lands
   in A's queue and nowhere else; an unverified address attributes nothing;
   a message with a passing `From` for A but B's alias is unattributed; a
   message with no authentication result is deleted silently with no reply;
   an authenticated unknown sender receives exactly one reply and the UID is
   gone from the mailbox; a second message from them the same day gets no
   second reply; nothing in the reply quotes the original.
5. **Per-user ingest pause** — `ingest_paused_at`, the `held` status, the
   receipt-time branch, resume via the retry pass, the relay page's `pause
   ingest` control replacing the read-only instance flag. *Accept:* mail to
   a paused user is `held` with no staging object or notification; resume
   stages it exactly once; expiry applies; sibling test extended to pause.
6. **Retire environment configuration** — one release after slices 1–2:
   `IMAP_*` to `removed_keys`, delete the retired overlay and secret-file
   guidance, drop `environment_configuration_ignored`. *Accept:* an install
   with stale keys fails closed with the distinct removed-key message;
   guarantee catalogue updated.

Slices 1–2 are hard to reverse (migration, config format) and cut alone
(`Cut: risk`); 3–5 may share a branch, with 4 landing before 5 because pause
applies to attributed mail. XOAUTH2 (device-code sign-in, refresh token as
`mail_in_secrets` kind `oauth_refresh_token`) is a separate issue that builds
on slice 1 and is not sliced here.

## Alternatives rejected

- **A separate mail-in KEK** (decision 1), **household relay addresses**
  (decision 4), **pause by skipping mail** (decision 2): rejected in place.
- **Memorable alias codes**, so that a member could type the address from
  memory: guessable, so anyone could post into that member's queue. The
  member never needs to type it (decision 3).
- **Sender matching without the provider's authentication result.** Turns a
  public fact (a member's email address) into a capability, and makes Orbit
  reply to whoever a spammer names in `From`.
- **Keeping unattributed mail for an administrator to assign.** Rejected by
  ADR-0005 and again here: it makes the administrator a reader of mail that
  no member has claimed, for a case the supported path does not produce.
- **Keep the alias secret in the environment and move only the password.**
  Leaves two authorities to reconcile — the complexity `imap-rotation.ts`
  exists to police — and per-user rotation needs the key in the application.
- **Per-user alias secrets instead of per-user generations.** More secret
  rows to protect and rewrap for no security gain: the HMAC input already
  binds user id and generation (`imap-recipient.ts:45`).
- **Let the admin page write `.orbit-secrets` files.** The application does
  not own that directory (`configure-engine.ts:428-445`) and a container-side
  write breaks the entrypoint's ownership model.
- **A SQL migration for the environment import.** Migrations cannot use the
  KEK and must stay data-only.

## Superseded

- The issue's original framing — a mailbox credential per user, inbound
  configuration in user settings — was superseded by the owner's ruling of
  2026-08-13 and is not designed here.
- The "queued case-fold fix" named in that ruling already landed in
  `98f59dd` (`core/imap-recipient.ts:19-27`); no slice carries it.
- The 2026-08-13 ladder's rungs 2–3 — sender address as a *fallback* after
  alias lookup, then a holding place for mail that matched nobody — were
  replaced by the owner on 2026-09-02 with decision 3: the sender attributes,
  the alias corroborates, and unmatched mail is answered and deleted.
- Handing a relay address to a third party, which the 2026-08-13 framing
  allowed and this record's first draft assumed, is unsupported and advised
  against (decision 3).

Written by Fable 5, 2026-09-02.
