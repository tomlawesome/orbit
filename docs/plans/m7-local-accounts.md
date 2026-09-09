# M7 — Local accounts: architecture and slice plan

Status: proposed 2026-09-09 for owner ratification, alongside ADR-0021,
ADR-0022 and ADR-0023. Epic: #259. Milestone: M7 — Local accounts. The
slice issues are listed at the end of #259's body.

This plan replaces the agent-produced plan note of 2026-08-16 on #259 where
they differ; the owner's six rulings on that note are binding and repeated in
the ADRs. The 2026-09-03 rescope also holds: there are no existing users, so
nothing here migrates, backfills or stays compatible with a prior state.

## 1. What changed since the 2026-08-16 note

Verified in the tree at `b879a60` (dev, 2026-09-09):

- **#263 is delivered.** `instance_authority` exists (migration 0027, a
  restrict FK), transfer exists, and `provisionIdentity` already seats the
  primary administrator under the `orbit:first-administrator` lock
  (`src/lib/auth/provision.ts:82-131`). The note's migration 0027 is not
  needed. "Claimed" means "the authority row exists".
- **The API moved.** The Next `src/app/api` tree is gone (#735); routes are
  SvelteKit handlers under `web/src/routes/api/**` importing the engine as
  `orbit/...` (ADR-0018). The `api` / `read` / `write` wrappers in
  `web/src/lib/server/api.js` supply the error envelope, session and CSRF.
- **#263 shipped a 15 minute freshness window for transfer**
  (`TRANSFER_FRESH_SESSION_SECONDS`, `src/server/admin-repository.ts:17`).
  Ruling 5 says no window ships; slice 7 replaces it. Flagged as a
  contradiction between code and rulings, resolved in favour of the ruling.
- **Migration numbering.** `drizzle/meta/_journal.json` ends at idx 37, tag
  `0037_mail_in_held_receipts`, `when` 1788220800000. M7's migration is
  `0038_local_credentials`, stamped **1788307200000**; a second, if ever
  needed, 1788393600000. Hand-written per `docs/testing.md` ("Hand-writing a
  migration"); `pnpm db:generate` refuses on purpose (#535).
- **Five e2e specs, not two,** depend on first-sign-in promotion:
  `v19-membership`, `v19-invitations`, `v19-arrival`, `v19-tour`,
  `v19-mail-collection`.
- **The base image is Node 22 on musl**, so Node's built-in Argon2 is not
  an option; `@napi-rs/canvas` with pinned platform packages is the precedent
  for a native module (ADR-0021).
- **The signed-out door** already learns configuration from
  `GET /api/auth/availability` (`{configured, phase, contactAddress}`), not
  from `/api/health`; the `login` page is prerendered static HTML. The door
  state machine is `web/src/lib/flight/door-state.js`.

## 2. Architecture

### 2.1 Modes and configuration (ADR-0023 §1)

- New keys in `ALLOWED_KEYS` (`src/lib/config-contract.ts:16-91`) and in
  `scripts/configuration.sh` / `scripts/configure.sh` in the **same commit**
  (the parity tests fail otherwise): `ORBIT_AUTH_OIDC` (`true|false`,
  default `false`) and `ORBIT_BOOTSTRAP_CLAIM_FILE` (canonical
  `/run/orbit-secrets/orbit-bootstrap-claim`).
- `evaluateReadiness` (`config-contract.ts:340-448`): OIDC fields
  `required()` only when `ORBIT_AUTH_OIDC=true`; when `false`, a non-blank
  OIDC field is a readiness failure ("set `ORBIT_AUTH_OIDC=true` or clear
  it"). The claim file is reported like the OIDC secret file: canonical path,
  regular file, mode.
- `AuthConfig` (`src/lib/env.ts`) becomes `{ appUrl, sessionSecret,
  sessionTtlSeconds, secureCookies, bootstrapClaimFile, oidc: null | {
  issuer, clientId, clientSecret, callbackUrl, scopes, claims } }`. Only
  `src/lib/auth/oidc.ts` and its test read the provider fields today, so the
  blast radius is small; `oidc.ts` functions take the non-null block.
- `getAuthConfig()` no longer throws in local-only mode, so
  `availability.configured` is true whenever `APP_URL` and `SESSION_SECRET`
  are valid. It gains `claimed` and `methods`.
- `.env-orbit.example` and `docs/installer-guarantees.md` document both.

### 2.2 Data model (ADR-0023 §2)

Migration `drizzle/0038_local_credentials.sql`, one statement per
`--> statement-breakpoint`, style of `drizzle/0025_household_join_requests.sql`:

```sql
CREATE TABLE "local_credentials" (
  "user_id" uuid PRIMARY KEY,
  "password_hash" text NOT NULL,
  "failed_attempt_count" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone,
  "last_verified_at" timestamp with time zone,
  "password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "local_credentials_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade
);
CREATE TABLE "credential_setup_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "purpose" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "credential_setup_tokens_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "credential_setup_tokens_purpose" CHECK ("purpose" IN ('setup','recovery')),
  CONSTRAINT "credential_setup_tokens_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "credential_setup_tokens_created_by_users_id_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null
);
CREATE INDEX "credential_setup_tokens_user_idx" ON "credential_setup_tokens" ("user_id");
CREATE UNIQUE INDEX "user_email_unique_ci" ON "users" (lower("email"));
```

`src/db/schema.ts` gains `localCredentials`, `credentialSetupTokens` and the
unique index; `tests/integration/support/migration-fixture.ts` gains the
expected columns, indexes and constraints. `src/lib/auth/authority-locks.ts`
gains `INSTANCE_BOOTSTRAP_LOCK_KEY = "orbit:first-administrator"`.

### 2.3 Module map

| Module | Owns |
|---|---|
| `src/lib/auth/password.ts` (new) | Argon2id policy constants, `hashPassword`, `verifyPassword → {verified, needsRehash}`, decoy hash, password bounds and NFC normalisation (ADR-0021). |
| `src/lib/auth/verification-gate.ts` (new) | The 2-concurrent / 16-queued / 5 s gate every derivation passes through. |
| `src/lib/auth/bootstrap.ts` (new) | Reads the claim file, `verifyClaim`, seal/open the claim cookie (audience `bootstrap-claim`), `isClaimed()`. |
| `src/lib/auth/crypto.ts` | Grows a generic `sealProof(payload, audience, ttl)` / `openProof(value, audience)` pair; `sealLoginTransaction` keeps its name and becomes a caller. Login transaction gains optional `bootstrap`, `linkUserId`, `stepUpSessionId`, `intent`, `maxAge` fields. |
| `src/lib/auth/oidc.ts` | `createAuthorizationUrl` gains `max_age` when the transaction asks; `validateIdTokenClaims` gains the `auth_time` freshness rule for step-up. Takes `config.oidc`. |
| `src/lib/auth/recent-auth.ts` (new) | `requireRecentAuthentication(event, session, body)`; seal/open the step-up proof cookie. |
| `src/server/local-credentials.ts` (new) | Repository: `createLocalUser`, `setPassword`, `verifyCredential` with persisted backoff, `issueSetupToken`, `consumeSetupToken`, `listMethods`, `unlinkLocal`, `unlinkIdentity` (last-usable-method rule under `ACCOUNT_LIFECYCLE_LOCK_KEY`). |
| `src/lib/auth/provision.ts` | Loses the auto-admin line; gains `{ bootstrap }` and the `link_required` collision refusal and the collision-safe email refresh. |
| `src/lib/auth/errors.ts`, `src/lib/logger.ts`, `src/server/admin-operations.ts` | Closed vocabularies extended exactly as ADR-0023 §8 lists. |
| `src/cli/orbit.ts` | `auth recovery-link` (ADR-0022 §5). |
| `web/src/routes/api/auth/**` | New handlers listed in 2.4. |
| `web/src/lib/flight/*`, `web/src/lib/arrival/*`, `web/src/routes/setup/[token]/`, `web/src/routes/settings/+page.svelte`, `web/src/routes/administration/+page.svelte` | UI (2.7). |

### 2.4 Routes

| Route | Guard | Answer |
|---|---|---|
| `GET /api/auth/availability` (existing) | none | adds `claimed`, `methods: {local, oidc}` |
| `POST /api/auth/bootstrap/claim` | same-origin, gate, backoff | sets claim cookie; `bootstrap_invalid`, `bootstrap_claimed`, `bootstrap_unavailable` |
| `POST /api/auth/bootstrap/local` | claim cookie | creates first admin + session; `bootstrap_claimed`, `password_rejected` |
| `GET /api/auth/login` (existing) | claim cookie while unclaimed | `bootstrap_required` when unclaimed and no cookie; `auth_not_configured` when `oidc` is null |
| `GET /api/auth/callback` (existing) | transaction cookie | branches on transaction kind: login / bootstrap / link / step-up |
| `POST /api/auth/local/login` | same-origin, gate, backoff | session; `credentials_invalid`, `too_many_attempts` |
| `POST /api/auth/local/password` | session + CSRF + recent auth | set or change; change revokes all sessions and re-issues the caller's |
| `POST /api/auth/local/setup` | setup token in body | consumes token, sets password, creates session; `setup_token_invalid` |
| `GET /api/auth/methods` | session | caller's own methods |
| `DELETE /api/auth/methods/local`, `DELETE /api/auth/methods/oidc/[identityId]` | session + CSRF + recent auth | `link_last_method` |
| `POST /api/auth/link/oidc/start` | session + CSRF + recent auth | 302 to provider |
| `POST /api/auth/step-up/start` | session + CSRF | 302 to provider with `max_age=0` |
| `POST /api/admin/users` (new verb on existing file) | admin + CSRF + recent auth | creates local user, returns setup URL once |
| `POST /api/admin/users/[userId]/setup-link` | admin + CSRF + recent auth | re-issues a `recovery` token, returns URL once |
| `POST /api/admin/primary` (existing) | + recent auth | window removed |

### 2.5 Sessions, CSRF, recent authentication

Unchanged: server-side session rows, `__Host-orbit-session`, `assertCsrf`.
Local sign-in and local bootstrap call `createSession` exactly as the
callback does and replace the browser's previous session. Recent
authentication is ADR-0023 §5; the step-up proof cookie is
`__Secure-orbit-step-up` (path `/`, 120 s, httpOnly, lax), consumed once.

### 2.6 Installer and secrets (ADR-0022 §1, §4)

- `scripts/configure.sh --init`: `ensure_secret_file bootstrap-claim` with a
  base32 renderer next to `generate_hex_secret` (`configure.sh:142-155`);
  `--set-bootstrap-claim` mirrors `--set-oidc-secret` (`configure.sh:873-930`)
  and the CLI `configure` verbs (`src/cli/orbit.ts:545-560`).
- `docker-compose.yml`: secret `orbit-bootstrap-claim` from
  `${ORBIT_SECRETS_DIR}/bootstrap-claim`, listed on the app service;
  `container-entrypoint.sh` stages it like the others (no zero-byte
  placeholder case: the installer always writes it).
- `install.sh`: the guided fields drop the OIDC trio from the required path;
  a mode question ("Sign in with local accounts only, or also with an
  identity provider? OIDC can be added later with `configure.sh`") sets
  `ORBIT_AUTH_OIDC`; `print_completion_screen` (`install.sh:1264-1278`) adds
  one line naming the claim file's path.
- `scripts/test-install-acceptance.sh` gains a local-only run;
  `docs/installer-guarantees.md` gains entries for the claim file.

### 2.7 UI surfaces

Design calls the owner ratifies first (ruling 3) — slice 11, `fable:
dialogue`:

- **Claim card**: the door's chrome present, one field ("claim code"), the
  path hint below it, replaces the Sign in gate while unclaimed.
- **Identity card**: chrome gone, small centred card, sky visible; two
  modes from one component — *create* (email, display name, password) for
  the bootstrap and *sign in* (email, password) for every later local
  sign-in; when OIDC is enabled a single "continue with your identity
  provider" line under the fields. Recommended composition: the ratified
  door stays pixel-identical and its Sign in gate opens the identity card
  in local mode, so the create-system card (untouched, three things only)
  remains stage two of first-run and stage one of nothing else.
- **Setup screen** `/setup/<token>`: the identity card in a third mode
  (password, password again) — same family, shape of
  `web/src/routes/invite/[token]/`.

Composition calls made here so the build slices contain none:

- Settings "You" (`web/src/routes/settings/+page.svelte:306-309`): the
  "signed in via your identity provider" line becomes a **Sign-in methods**
  block listing Password (set / not set, changed date; actions Change,
  Remove) and each linked provider (issuer host, linked date; action
  Unlink), plus one "Link your identity provider" action when OIDC is
  enabled and unlinked. The recent-auth challenge is inline: a password
  field appears under the armed action (the two-tap pattern "Sign out of
  every device" already uses at `:237-260`); an OIDC-only user's action
  redirects to the step-up and returns to the same block.
- Administration users table: an **Add a local user** row above the table
  (email, display name, Create) whose success state shows the setup link
  once with a Copy control and the words "shown once"; each local user's
  row gains "Send a new setup link" behind the same inline challenge.

### 2.8 Audit and operational records

Actions and reasons are the closed lists in ADR-0023 §8. `changes` payloads:
`instance_claimed {method: "local"|"oidc"}`, `local_user_created {userId}`,
`setup_link_issued {userId, purpose}`, `recovery_link_issued {userId}`,
`password_changed {sessionsRevoked: n}`, `identity_linked {identityId}`,
`identity_unlinked {identityId}`. Never emails, never tokens, never
provider payloads.

### 2.9 Backup and restore

`scripts/backup.sh` uses `pg_dump --format=custom` of the whole database, so
the new tables ride the archive with no change. `scripts/test-backup-restore.sh`
seeds by SQL and is the only thing that would catch a dropped column: it
gains a local credential, a setup token and an identity, and asserts after
restore that the credential verifies, the unconsumed token is still
unconsumed, and no session survived (the documented revocation boundary).

### 2.10 e2e strategy

- `tests/e2e/support/bootstrap.ts` (new): `claimInstanceAsAdministrator(browser)`
  reads `${ORBIT_SECRETS_DIR:-./.orbit-secrets}/bootstrap-claim` from the
  host, POSTs the claim, then completes the OIDC bootstrap as "Orbit
  Administrator"; idempotent (a claimed instance short-circuits). The five
  specs swap `establishInstanceAdmin` for it in the slice that closes the
  hole, so the acceptance stage never goes red between slices.
- `compose/docker-compose.local-only.yml` (new overlay): `ORBIT_AUTH_OIDC=false`,
  no provider sidecar; a small local-only spec list.
- New specs: `bootstrap-protection.spec.ts` (the negative that matters),
  `local-sign-in.spec.ts`, `sign-in-methods.spec.ts`; `signed-out.spec.ts`
  extended for privacy.

## 3. Slices

Sizing target: one Sonnet-class agent, one sitting, 200–500 lines with
tests, no design calls. Every slice: commit to its branch and report; the
orchestrator merges into the batch branch. Every slice names an existing
spec to copy the shape of. `Refs #259` on every commit; `Closes #<slice>`
on the final one of each.

| # | Slice | Depends on | Parallel with |
|---|---|---|---|
| 1 | Config: `ORBIT_AUTH_OIDC`, claim-file key, `AuthConfig.oidc` | — | 2, 3, 11 |
| 2 | Migration 0038 and schema | — | 1, 3, 11 |
| 3 | Password module and verification gate | — | 1, 2, 11 |
| 4 | Installer: claim secret, mode question, compose, entrypoint | 1 | 5, 6 |
| 5 | Claim endpoint, OIDC bootstrap gate, provisioning policy, e2e helper | 1, 2 | 4 |
| 6 | Local bootstrap and local sign-in | 3, 5 | 4 |
| 7 | Recent authentication (inline password, OIDC step-up), transfer adopts it | 6 | 8 |
| 8 | Setup tokens: admin-created local users, `/api/auth/local/setup`, password set/change | 6 | 7 |
| 9 | Primary-administrator recovery CLI | 8 | 10, 12 |
| 10 | Methods list, link, unlink | 7 | 9, 12 |
| 11 | Mockups: claim card, identity card, door in local mode (`fable: dialogue`) | — | 1–3 |
| 12 | Door and first-run cards build; setup screen | 11 ratified, 6, 8 | 9, 10 |
| 13 | Settings sign-in methods; administration add-local-user | 8, 10, 12 | 14 |
| 14 | e2e: bootstrap protection, local-only profile, signed-out privacy | 12 | 13 |
| 15 | Backup drill assertions and operator documentation | 13, 14 | — |

Shared files several slices touch (expect reconciliation, not conflict-free
merges): `src/lib/auth/errors.ts`, `src/lib/logger.ts`,
`src/server/admin-operations.ts` (`actionLabels`),
`web/src/routes/api/auth/callback/+server.js`, `src/lib/auth/crypto.ts`.
Slice 5 lands the callback's kind switch; 7 and 10 add branches to it.

### Slice 1 — Config: optional OIDC and the claim-file key

- **Outcome:** local-only startup is explicit and passes readiness with no
  provider values; `AuthConfig.oidc` is `null` or the provider block.
- **Touches:** `src/lib/env.ts`, `src/lib/config-contract.ts`,
  `scripts/configure.sh`, `scripts/configuration.sh`, `.env-orbit.example`,
  `src/lib/auth/oidc.ts` (take `config.oidc`),
  `web/src/routes/api/auth/availability/+server.js` (`methods`; `claimed`
  arrives in slice 5 as `false` until then — return `claimed: true` for now
  so the door behaves as today), `web/src/routes/api/auth/{login,logout,callback}`
  (`auth_not_configured` when `oidc` is null).
- **Done when:** `configure.sh --check` and `evaluateReadiness` agree on a
  local-only fixture and an OIDC fixture; `ORBIT_AUTH_OIDC=false` with a
  non-blank `OIDC_ISSUER` fails readiness by field name; the existing e2e
  stack (OIDC enabled) is unchanged.
- **Tests:** extend `src/lib/env.test.ts`, `config-contract.parity.test.ts`,
  `config-contract.example.test.ts`, `scripts/configure.test.mjs`,
  `scripts/configuration.test.mjs`; shape: the existing cases in each.

### Slice 2 — Migration 0038 and schema

- **Outcome:** `local_credentials`, `credential_setup_tokens`, the
  case-insensitive unique email index, `INSTANCE_BOOTSTRAP_LOCK_KEY`.
- **Touches:** `drizzle/0038_local_credentials.sql`,
  `drizzle/meta/_journal.json` (idx 38, `when` 1788307200000, version 7,
  breakpoints true), `src/db/schema.ts`, `src/lib/auth/authority-locks.ts`,
  `tests/integration/support/migration-fixture.ts`.
- **Done when:** `tests/integration/migrations.test.ts` passes with the new
  expectations; inserting two users differing only in email case fails.
- **Tests:** `migrations.test.ts` (shape: its existing table/index cases).

### Slice 3 — Password module and verification gate

- **Outcome:** `hashPassword`, `verifyPassword`, `needsRehash`, decoy hash,
  bounds, and the gate, with the dependency shipped. Follow the
  dependencies-and-data skill: current version, MIT confirmed, platform
  packages pinned like `@napi-rs/canvas`.
- **Touches:** `package.json`, `web/package.json`, `pnpm-lock.yaml`,
  `src/lib/auth/password.ts`, `src/lib/auth/verification-gate.ts`,
  `docs/supply-chain.md` (one paragraph beside the canvas entry).
- **Done when:** hash round-trip; a hash made at lower `m` reports
  `needsRehash`; a 300-code-point password is rejected before hashing; the
  gate refuses the 19th concurrent caller and releases on completion; the
  `licence_policy` script passes locally on the shipped tree.
- **Tests:** `src/lib/auth/password.test.ts`, `verification-gate.test.ts`
  (shape: `src/lib/auth/crypto.test.ts`).

### Slice 4 — Installer: claim secret, mode question, compose and entrypoint

- **Outcome:** a fresh install writes the claim file, asks local-only vs
  local-plus-OIDC, no longer requires the OIDC trio, and tells the operator
  where the claim lives.
- **Touches:** `scripts/configure.sh` (`ensure_secret_file` for
  `bootstrap-claim`, base32 renderer, `--set-bootstrap-claim`),
  `scripts/configuration.sh`, `src/cli/orbit.ts` (`configure` verbs),
  `scripts/install.sh` (guided fields, mode prompt, completion line),
  `scripts/installer-ui.sh` if the prompt needs a widget,
  `docker-compose.yml`, `scripts/container-entrypoint.sh`,
  `docs/installer-guarantees.md`, `scripts/test-install-acceptance.sh`
  (local-only run).
- **Done when:** `--init` on an empty directory yields a `0600` base32 claim
  file; `--set-bootstrap-claim` replaces it atomically without echo; the
  entrypoint stages it `0400`; the install acceptance script reaches a
  healthy `/api/health` with `ORBIT_AUTH_OIDC=false` and no OIDC values;
  the installer's own output never contains the value.
- **Tests:** `scripts/configure.test.mjs`, `scripts/oidc-secret-contract.test.mjs`
  (add a claim-file twin), `scripts/installer-ui.test.mjs`.

### Slice 5 — Claim endpoint, OIDC bootstrap gate, provisioning policy

- **Outcome:** an unclaimed instance can only be claimed with the claim
  secret; the first OIDC sign-in after a claim becomes primary
  administrator; after the claim, OIDC self-registers and email collisions
  are refused; the e2e helper claims deterministically.
- **Touches:** `src/lib/auth/bootstrap.ts`, `src/lib/auth/crypto.ts`
  (`sealProof`/`openProof`, transaction `bootstrap` field),
  `src/lib/auth/provision.ts`, `src/lib/auth/errors.ts`, `src/lib/logger.ts`,
  `src/server/admin-operations.ts`, `web/src/routes/api/auth/bootstrap/claim/+server.js`,
  `web/src/routes/api/auth/login/+server.js`,
  `web/src/routes/api/auth/callback/+server.js` (kind switch),
  `web/src/routes/api/auth/availability/+server.js` (`claimed`),
  `tests/e2e/support/bootstrap.ts` and the five specs' helper swap.
- **Done when:** with no claim cookie `GET /api/auth/login` answers 403
  `bootstrap_required` and `users` stays empty; a wrong claim answers
  `bootstrap_invalid`; N concurrent OIDC bootstraps with valid cookies yield
  one authority row and N−1 `bootstrap_claimed`; a second `(issuer,
  subject)` after the claim becomes an ordinary user; a new subject with an
  existing email gets `link_required` and creates nothing; a missing claim
  file logs the bounded blocked record and refuses every route.
- **Tests:** `tests/integration/bootstrap.test.ts` (shape:
  `primary-administrator.test.ts` for the route calls,
  `reviewed-intake-concurrency.test.ts` for the race);
  `src/lib/auth/provision.test.ts` (new; shape `session.test.ts`).

### Slice 6 — Local bootstrap and local sign-in

- **Outcome:** the first administrator can be created with a password, and
  local users sign in with generic, timed-alike failures and persisted
  backoff.
- **Touches:** `src/server/local-credentials.ts` (`createLocalUser`,
  `verifyCredential`, backoff), `web/src/routes/api/auth/bootstrap/local/+server.js`,
  `web/src/routes/api/auth/local/login/+server.js`, `errors.ts`, `logger.ts`.
- **Done when:** local bootstrap under a valid claim seats the primary and
  returns a session; unknown email, wrong password, disabled user and
  credential-less user all return the same status and body; the sixth
  failure locks with doubling `locked_until` to a 15 minute cap; a correct
  password during lock is refused; success clears the counter and re-hashes
  when `needsRehash`; a container restart does not reset the counter (it is
  a row).
- **Tests:** `tests/integration/local-sign-in.test.ts` (shape:
  `auth-session-contracts.test.ts`); a loose timing-overlap assertion, not
  a strict bound.

### Slice 7 — Recent authentication

- **Outcome:** one guard for every sensitive action: inline password for
  local users, `max_age=0` step-up with fresh `auth_time` for OIDC-only
  users; primary transfer uses it and its 15 minute window is deleted.
- **Touches:** `src/lib/auth/recent-auth.ts`, `src/lib/auth/oidc.ts`
  (`max_age`, `auth_time` rule), `src/lib/auth/crypto.ts` (step-up
  transaction fields), `web/src/routes/api/auth/step-up/start/+server.js`,
  `callback/+server.js` (step-up branch), `src/server/admin-repository.ts`
  (`transferPrimaryAdministrator` takes the proof; constant removed),
  `web/src/routes/api/admin/primary/+server.js`, `tests/oidc/server.mjs`
  (honour `max_age=0` and emit `auth_time`; a switch to emit a stale one).
- **Done when:** a local user's action with a wrong or missing
  `currentPassword` is `recent_authentication_required`; an OIDC user's
  action without proof is the same; a step-up whose `auth_time` is 90 s old
  is `step_up_failed` and the action stays blocked; the proof is consumed
  once; a 16 minute old session transfers primary authority with a fresh
  challenge and no longer without one.
- **Tests:** `src/lib/auth/oidc.test.ts` (auth_time cases),
  `tests/integration/recent-authentication.test.ts` (shape:
  `primary-administrator.test.ts`), update `primary-administrator.test.ts`.

### Slice 8 — Setup tokens, admin-created local users, password set and change

- **Outcome:** administrators create local users without learning their
  passwords; users set and change passwords; a change signs every other
  device out.
- **Touches:** `src/server/local-credentials.ts` (`issueSetupToken`,
  `consumeSetupToken`, `setPassword`), `web/src/routes/api/admin/users/+server.js`
  (POST), `web/src/routes/api/admin/users/[userId]/setup-link/+server.js`,
  `web/src/routes/api/auth/local/setup/+server.js`,
  `web/src/routes/api/auth/local/password/+server.js`, `admin-operations.ts`
  labels.
- **Done when:** POST creates a user with no credential and returns the URL
  once; the list never contains it; consuming a token sets the password,
  marks it consumed, creates a session; a consumed or expired token is
  `setup_token_invalid`; a password change revokes N sessions and the caller
  keeps a working one; a non-administrator gets 403 from both admin routes.
- **Tests:** `tests/integration/local-setup-tokens.test.ts` (shape:
  `household-invitations.test.ts` for the token lifecycle).

### Slice 9 — Primary-administrator recovery CLI

- **Outcome:** `orbit auth recovery-link` from the deployment host.
- **Touches:** `src/cli/orbit.ts`, `docs/administrator-operations.md`
  (section "Recovering the primary administrator").
- **Done when:** the command prints exactly one URL to stdout, writes
  nothing to the logger, revokes the primary's sessions, writes
  `recovery_link_issued`; refuses when `instance_authority` is empty with a
  bounded message; the link consumes like a setup token.
- **Tests:** `src/cli/orbit.auth.test.ts` (new; shape:
  `src/cli/orbit.configure.test.ts`).

### Slice 10 — Methods list, link and unlink

- **Outcome:** a signed-in user sees their methods, links OIDC, removes
  either method while one remains.
- **Touches:** `src/server/local-credentials.ts` (`listMethods`,
  `unlinkLocal`, `unlinkIdentity`), `web/src/routes/api/auth/methods/+server.js`,
  `.../methods/local/+server.js`, `.../methods/oidc/[identityId]/+server.js`,
  `web/src/routes/api/auth/link/oidc/start/+server.js`, `callback/+server.js`
  (link branch), `crypto.ts` (`linkUserId`).
- **Done when:** link inserts an identity for the session's user; linking a
  subject already linked elsewhere is `link_exists`; unlinking the last
  usable method is `link_last_method`; with `ORBIT_AUTH_OIDC=false` an
  identity does not count as usable; both methods sign in after a link.
- **Tests:** `tests/integration/sign-in-methods.test.ts` (shape:
  `auth-session-contracts.test.ts`).

### Slice 11 — Mockups: claim card, identity card, door in local mode (Fable dialogue)

- **Outcome:** the owner ratifies the two cards and how the ratified door
  offers a password, before slice 12 is built (ruling 3).
- **Touches:** `design/v19/claim-and-identity/round-N/*.html`,
  `design/owner-decisions.md` (the ruling, once given). Hosted from an
  `nginx:alpine` container per AGENTS.md; a mockup is never a file path.
- **Done when:** the owner's ruling is recorded in `owner-decisions.md` and
  on the issue, naming the round accepted.
- **Design brief:** section 2.7 above; the "three things only" law governs
  the create-system card and is untouched.

### Slice 12 — Door and first-run cards; setup screen

- **Outcome:** the ratified cards ship; the door is mode-aware; `/setup/<token>`.
- **Touches:** `web/src/lib/flight/SignIn.svelte`, `door-state.js`,
  `web/src/lib/flight/Claim.svelte`, `Identity.svelte`,
  `web/src/routes/setup/[token]/+page.server.js`, `+page.svelte`,
  `web/src/routes/+page.js` / `login/+page.js` as the ratification requires,
  `web/tests/fidelity/screens.spec.js` and baselines for the new screens.
- **Done when:** unclaimed shows the claim card and no gate; a valid claim
  reveals the identity card in create mode; a claimed local-only instance
  opens the identity card in sign-in mode from the gate; an OIDC-enabled
  instance shows the provider line; every card passes the AxeBuilder sweep;
  fidelity baselines exist and match.
- **Tests:** `tests/e2e/v19-first-run-door.spec.ts` extended; a11y via the
  pattern in `signed-out.spec.ts:119`.

### Slice 13 — Settings sign-in methods; administration add-local-user

- **Outcome:** the two composed blocks in 2.7, with the inline challenge.
- **Touches:** `web/src/routes/settings/+page.svelte`, `settings.css`,
  `web/src/routes/administration/+page.svelte`, `administration.css`,
  `web/src/lib/data/fixtures/admin.js` (fixture rows for the new controls).
- **Done when:** the fixture harness renders both blocks; a local user can
  change their password with the inline field; an OIDC-only user is sent to
  the step-up and returns to the block; an administrator creates a local
  user and sees the link once; keyboard and screen-reader coverage of the
  new controls.
- **Tests:** `tests/e2e/sign-in-methods.spec.ts` (shape:
  `v19-membership.spec.ts`), `v19-keyboard.spec.ts` extension.

### Slice 14 — e2e: bootstrap protection, local-only profile, signed-out privacy

- **Outcome:** the negative journeys the owner asked for, in the exact image.
- **Touches:** `tests/e2e/bootstrap-protection.spec.ts`,
  `tests/e2e/local-sign-in.spec.ts`, `tests/e2e/signed-out.spec.ts`,
  `compose/docker-compose.local-only.yml`, `scripts/test-e2e-local.sh`
  (profile switch), `.gitlab-ci.yml` acceptance job (second profile),
  `docs/quality-strategy.md` (the new lane).
- **Done when:** on a fresh database an attacker without the claim cannot
  reach the provider, create a user or see anything but the claim card; a
  15 minute old claim cookie is refused; a replayed valid claim after the
  bootstrap is `bootstrap_claimed`; the local-only profile claims, signs
  in, signs out and signs in again; no signed-out route reveals whether an
  email exists or which provider is configured.
- **Tests:** the files above (shape: `signed-out.spec.ts`).

### Slice 15 — Backup drill assertions and operator documentation

- **Outcome:** restore proves the revocation boundary; the documentation
  covers first claim, local-only, later OIDC, linking, recovery, and the
  sign-out asymmetry in plain words.
- **Touches:** `scripts/test-backup-restore.sh`, `docs/authentication.md`
  (rewrite: it opens "Orbit is an OpenID Connect relying party"),
  `docs/administrator-operations.md`, `docs/installer-guarantees.md`,
  `docs/architecture.md` (auth paragraph), `README.md` if it names OIDC as
  required.
- **Done when:** the drill seeds and asserts per 2.9; every new operator
  command appears once with why it is needed; the trust boundary sentence
  from ADR-0022 §6 is present.
- **Tests:** `scripts/test-backup-restore.sh` itself.

## 4. Superseded

- **`instance_authority` migration, backfill and zero-admin refusal** — done
  by #263; no backfill because no users exist.
- **`registration_policy` and `local_sign_in_enabled` columns and the
  `PATCH /api/admin/auth-policy` route** — policy fixed by ruling 4; no
  toggle in M7.
- **`GET /api/auth/bootstrap`** — folded into `availability`.
- **scrypt and the `scrypt$…` encoding** — ADR-0021.
- **Per-IP token bucket** — no trusted-proxy contract; per-credential
  backoff plus the gate instead.
- **`users.email` unique-index pre-flight detector** — no existing rows.
- **Upgrade journey (previous image with OIDC admin, then candidate)** —
  rescoped out on 2026-09-03.
- **First-run as a new route** — the ratification says it sits on top of
  the login screen; a stage, not a route.
- **Deleting the claim file after use** — state enforces single use.
- **Password reset by email, breached-password list, trusted-proxy
  contract, SSO-only mode** — each its own future issue.

## 5. Open questions for the owner

Numbered here from 1; the relaying session renumbers.

1. **Door composition (slice 11).** The recommendation keeps the ratified
   door pixel-identical and opens the identity card from its Sign in gate,
   so a local sign-in is two steps (gate, then card). The alternative is
   email and password on the door itself, which changes a ratified screen.
   Which should the mockup round start from?
2. **Claim code shape.** 32 bytes as base32 in groups of four is 52
   characters to type from a file viewer. Acceptable, or prefer 20 bytes
   (32 characters, still far beyond guessing under the backoff)?
3. **Recovery CLI output.** The one-time URL is printed to the operator's
   terminal (never the container log). Acceptable, or must it be written to
   a file in `.orbit-secrets` and never displayed?
4. **Transfer strictness.** Replacing #263's 15 minute window with a
   challenge makes primary transfer stricter than it shipped. Confirm that is
   intended by ruling 5 (the plan assumes yes).
