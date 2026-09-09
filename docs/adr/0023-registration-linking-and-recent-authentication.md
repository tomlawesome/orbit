# ADR-0023: One user, two optional sign-in methods; OIDC self-registers, local is administrator-created, sensitive actions always re-challenge

**Status:** Proposed (for owner ratification; drafted 2026-09-09 under the
owner's rulings of 2026-08-16 on #259: registration policy, recent
authentication, and the sign-out asymmetry)
**Date:** 2026-09-09
**Relates to:** #259 (local accounts, epic); #263 (primary administrator —
its transfer freshness rule is replaced here); ADR-0021 (hashing), ADR-0022
(claim and recovery); `docs/authentication.md` (rewritten by the docs
slice); `docs/plans/m7-local-accounts.md`

## Context

`users` is the single identity and `external_identities` is the immutable
`(issuer, subject)` link (`src/db/schema.ts:75-84, 246-253`). Email is a
non-unique lookup index; OIDC refreshes it on every sign-in. Sessions are
server-side rows, provider-agnostic, revoked by deleting rows
(`src/lib/auth/session.ts`). CSRF is same-origin plus a session-bound HMAC
token (`assertCsrf`). Configuration makes `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
`OIDC_CLIENT_SECRET` unconditionally required (`src/lib/env.ts:16-18`,
`src/lib/config-contract.ts:340-448`).

#263 shipped a 15 minute "fresh session" window for primary transfer
(`TRANSFER_FRESH_SESSION_SECONDS`, `src/server/admin-repository.ts:17,
308-323`) with a comment that in-session re-authentication "arrives with
#259". The owner ruled on 2026-08-16 that no freshness window ships: every
sensitive action re-challenges.

The owner's rulings this record turns into a model:

- **Registration (ruling 4):** no Orbit account exists until a successful
  OIDC login; that login creates the account, and the user takes the
  ordinary newcomer journey. Local accounts are created by an administrator,
  who issues a setup token.
- **Recent authentication (ruling 5):** always challenge, both account types.
  Local users re-enter the password inline; OIDC users take a step-up with
  `max_age=0`, and Orbit verifies `auth_time` is within about 60 s. Fail
  closed.
- **Sign-out (ruling 6):** document plainly that revoking Orbit sessions
  cannot end the provider's own session; no `prompt=login` dependency.

## Decision

### 1. Authentication modes

Local sign-in is always available; it is the baseline. OIDC is enabled by
one explicit key, **`ORBIT_AUTH_OIDC=true|false`** (default `false`). When
`true`, the three OIDC fields are required exactly as today; when `false`,
they are **ignored and may remain set** — the owner wants to switch the
provider off without deleting its configuration (ruling, 2026-09-09).
Readiness therefore checks the OIDC fields only when the key is `true`, and
`configure.sh --check` reports them as "not in use" rather than as errors
when it is `false`. `AuthConfig.oidc` becomes `null` or the provider block,
and every OIDC route answers `auth_not_configured` when it is `null`. A
half-configured provider with the key `true` is still a readiness failure. `GET /api/auth/availability` gains `claimed: boolean` and
`methods: { local: true, oidc: boolean }`; it still reveals nothing about
accounts.

Disabling local sign-in ("SSO only") is not in M7: #259 allows it only once
"another usable administrator path is proven", and nothing needs it yet. A
later issue may add it with its own proof rule.

### 2. Data model

- `local_credentials` (new, 1:1 optional child of `users`): `user_id` PK FK
  cascade, `password_hash` (PHC string, ADR-0021), `failed_attempt_count`,
  `locked_until`, `last_verified_at`, `password_changed_at`, audit
  timestamps.
- `credential_setup_tokens` (new): `id`, `user_id` FK cascade, `token_hash`
  unique (sha256 of a 32-byte token), `purpose` (`setup` | `recovery`),
  `expires_at`, `consumed_at`, `created_by_user_id` nullable (null when the
  CLI issued it), `created_at`.
- `users.email` gains a **case-insensitive unique index** (`lower(email)`).
  There are no existing rows, so this is a plain index, not a migration
  risk. Because the provider may later change a linked user's email to one
  another user already holds, the OIDC profile refresh keeps the stored
  email when the new one would collide, rather than failing the sign-in.
- Nothing is added to `instance_authority`.

A user therefore has a credential, an identity, or both. "Both" is the
linked case.

### 3. Who creates accounts

- **First administrator:** the claim (ADR-0022), local or OIDC.
- **OIDC, after the claim:** a successful sign-in whose `(issuer, subject)`
  has no row creates a user and an identity, unless the email already
  belongs to a user, in which case the sign-in is refused with the fixed
  `link_required` message: sign in to the existing Orbit account and link
  this provider from settings. The message is the same whether or not the
  email exists; nothing is created. Email equality, verified or not, never
  links anything.
- **Local, after the claim:** an administrator creates the user (email,
  display name) from the administration screen. The response carries the
  setup URL once; the list never shows it. The new user opens
  `/setup/<token>`, chooses a password, and is signed in; they then take the
  newcomer arrival like anyone else. Administrators re-issue a setup token
  (purpose `recovery`) for a local user who has forgotten their password;
  the primary administrator's own recovery is the CLI (ADR-0022 §5).
- There is no anonymous self-registration and no toggle for one.

### 4. Sign-in

`POST /api/auth/local/login { email, password }` answers only
`credentials_invalid` (unknown email, wrong password, disabled account, no
credential — all the same status and body, timed alike through the decoy
hash) or `too_many_attempts`. Backoff is per credential and persisted:
5 free attempts, then `locked_until` doubling from 1 s to a 15 minute
ceiling; cleared on success; never permanent. The in-process verification
gate (ADR-0021 §4) sits in front. A successful local sign-in replaces the
browser's previous session exactly as the OIDC callback does.

### 5. Recent authentication: always challenge

One function, `requireRecentAuthentication(event, session, body)`, guards
every sensitive action: set or change password, link, unlink, re-issue a
setup token for someone else, and **transfer primary authority** (#263's
window is deleted; the transfer calls this instead).

- If the user has a local credential, the request body carries
  `currentPassword`; it is verified under the same backoff and gate as a
  sign-in. No password, or a wrong one, is `recent_authentication_required`.
- Otherwise the user is OIDC-only and does a **step-up**:
  `POST /api/auth/step-up/start { intent }` seals a transaction (audience
  `oidc-step-up`, carrying the session id and intent) and sends the browser
  to the provider with `max_age=0`. The callback branch verifies the ID token
  as today and additionally requires an `auth_time` claim no older than
  **60 s** (`clockTolerance` 5 s). It then sets a sealed proof cookie
  (`__Secure-orbit-step-up`, audience `step-up-proof`, bound to session id
  and intent, **120 s** TTL) and returns the browser to the action. The
  action consumes and clears the proof. A provider that returns no
  `auth_time`, or a stale one, gets `step_up_failed` and the action stays
  blocked until the operator fixes the provider: that is the correct failure
  direction.
- Users with both methods are challenged with the password: it is cheaper,
  offline, and has no provider dependency.

### 6. Linking and unlinking

- **Link OIDC to a local account:** `POST /api/auth/link/oidc/start` (session,
  CSRF, recent authentication) seals a transaction (audience `oidc-link`,
  carrying the user id) and redirects to the provider. The callback branch
  verifies the token and inserts an `external_identities` row for that
  user; the unique index turns "already linked to someone else" into
  `link_exists`. Audit `identity_linked`.
- **Add a password to an OIDC account:** `POST /api/auth/local/password`
  with a step-up proof; audit `password_set`.
- **Unlink either method:** `DELETE /api/auth/methods/oidc/{identityId}` and
  `DELETE /api/auth/methods/local`, with recent authentication, inside the
  `ACCOUNT_LIFECYCLE_LOCK_KEY` transaction, refused with `link_last_method`
  unless at least one usable method remains — a credential, or an identity
  while `ORBIT_AUTH_OIDC=true`. Audit `identity_unlinked`, `password_removed`.
- `GET /api/auth/methods` lists the caller's own methods: `local: { set:
  boolean, changedAt }` and `oidc: [{ id, issuer, linkedAt, lastLoginAt }]`.
  Never another user's.

### 7. Sessions and revocation

`revokeUserSessions` is already provider-agnostic. What changes is who calls
it: a **password change** revokes every session and re-issues the caller's
in the same response; setting a first password, linking and unlinking
revoke nothing; disabling an account already deletes sessions in
transaction, and re-enabling never revives them. The documentation states
the asymmetry in plain words: signing out of Orbit everywhere ends every
Orbit session, and cannot end the identity provider's own session, so an
OIDC user may be signed straight back in by a provider that still remembers
them.

### 8. Bounded words and records

New `AuthErrorCode` members: `bootstrap_required`, `bootstrap_unavailable`,
`bootstrap_invalid`, `bootstrap_claimed`, `credentials_invalid`,
`too_many_attempts`, `recent_authentication_required`, `step_up_failed`,
`password_rejected`, `link_required`, `link_exists`, `link_last_method`,
`setup_token_invalid`. New audit actions, added to `actionLabels` in
`src/server/admin-operations.ts` so the administration screen never renders
a raw string: `instance_claimed`, `password_set`, `password_changed`,
`password_removed`, `identity_linked`, `identity_unlinked`,
`local_user_created`, `setup_link_issued`, `recovery_link_issued`. `changes`
payloads carry ids, booleans and counts only. New `operationalReasons`:
`bootstrap_unclaimed`, `bootstrap_rejected`, `credentials_rejected`,
`attempts_exhausted`, `step_up_rejected`.

## Consequences

- `AuthConfig`'s shape changes for every auth route and for
  `route-contract` tests that construct it literally; this is the first
  slice, on its own, with characterisation tests.
- The #263 transfer becomes stricter (a challenge instead of a 15 minute
  window) and its integration test changes with it.
- The newcomer arrival is reachable by an OIDC user with no invitation, as
  the owner ruled. Operators who want closed enrolment close it at the
  provider.
- Local users are enumerable by nobody: every failure is one word, one
  status, one cost. Administrators alone see the user list, as today.
- Backup and restore need no new steps: `pg_dump` takes the whole database,
  so the credential, token and identity tables ride the archive; the
  backup-restore drill gains assertions, not mechanisms.

## Alternatives rejected

- **Freshness window (5 or 15 minutes since sign-in)**: ruled out by the
  owner on 2026-08-16; a window is a bearer token for anyone at an unlocked
  screen.
- **`prompt=login` after a revoke**: a provider-behaviour dependency the
  generic OIDC contract cannot guarantee.
- **Registration policy as an administrator setting (`closed` / `oidc_only`
  / `open`)**: the owner fixed the policy; a setting with one valid value is
  a trap.
- **Email-based password reset**: SMTP becomes an authentication dependency
  and an enumeration surface. Its own issue if ever wanted.
- **Per-IP rate limiting**: without a trusted-proxy contract every request
  behind a reverse proxy shares one address, so it degrades to a global
  bucket; the per-credential backoff and the verification gate do the work.
- **Breached-password deny-list**: a data file with a licence and an update
  cadence; its own issue.

## Superseded

- `TRANSFER_FRESH_SESSION_SECONDS` (#263) is superseded by §5 and deleted by
  the recent-authentication slice.
- The three-valued `registration_policy` and `local_sign_in_enabled` columns
  in the 2026-08-16 plan note are dropped (no column, no toggle).
- The plan note's route table was written for the Next `src/app/api` tree,
  which #735 replaced with SvelteKit routes under `web/src/routes/api`; the
  slice plan carries the current paths.
