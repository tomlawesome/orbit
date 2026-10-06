# ADR-0022: The instance is claimed with a code printed once in the container's own log, and a lost administrator is recovered from the deployment host

**Status:** Proposed (for owner ratification; drafted 2026-09-09; revised the
same day under the owner's ruling that the claim is a boot-time log line,
not a file — this replaces ruling 2 of 2026-08-16 on #259)
**Date:** 2026-09-09
**Relates to:** #259 (local accounts, epic); #263 (primary administrator,
delivered — the `instance_authority` singleton this record builds on);
ADR-0021 (password hashing), ADR-0023 (registration, linking, recent
authentication); ADR-0008 and `docs/installer-guarantees.md` (the installer
contract this extends); ADR-0004 (restore contract);
`docs/plans/m7-local-accounts.md`

## Context

Today the first identity the configured provider authenticates becomes the
instance administrator and the primary administrator: `provisionIdentity`
counts users under the `orbit:first-administrator` advisory lock and sets
`isInstanceAdmin: registeredUsers === 0`, then seats `instance_authority`
(`src/lib/auth/provision.ts:82-131`). The lock makes the race safe (one
winner) and says nothing about who wins. Five e2e specs depend on that
promotion through an `establishInstanceAdmin` helper
(`tests/e2e/v19-membership.spec.ts:38`, `v19-invitations`, `v19-arrival`,
`v19-tour`, `v19-mail-collection`).

With local accounts no provider is needed, so without a claim step the
window would be "anyone who can resolve the name". Certificate-transparency
logs publish a new name within minutes of issuance, so "nobody knows the
address yet" is not a control.

The 2026-08-16 ruling chose an installer-generated secret file in
`.orbit-secrets`. On 2026-09-09 the owner replaced it: the claim is
**printed as the last line of the container's start-up log**, as a clickable
link and as a plain code, and lives nowhere else. The owner heard that this
reverses #259's original acceptance line ("displayed/stored without entering
shell history or ordinary logs") and that shipped container logs would carry
the code during the unclaimed window, and kept the decision.

There are no existing deployments (owner, 2026-09-03), so there is no
backfill and no compatibility clause: the first sign-in is the first
sign-in.

Facts the design rests on:

- `instance_authority` exists (#263, migration 0027): a `singleton boolean
  PK`, `primary_user_id` with `ON DELETE RESTRICT`. Its presence is the
  "claimed" fact; nothing else needs inventing.
- Start-up ends in `registerNode` (`src/server/boot.ts:153`): configuration
  validated, migrations applied, workers started. Anything printed after
  its last record is the last line of `docker logs orbit-app` until the first
  request arrives.
- The operational logger (`src/lib/logger.ts`) refuses to interpolate values:
  `operationalDetail` renders anything that is not a bounded identifier as
  `[unavailable]`. A URL and a secret are values, so the claim notice cannot
  travel through that protocol and must be an explicit, documented exception.
- `sealLoginTransaction` / `openLoginTransaction` (`src/lib/auth/crypto.ts`)
  seal a short-lived JWE under `SESSION_SECRET` with a fixed audience; the
  audience is the extension point for other short-lived proofs.
- The bundled CLI runs only inside the container
  (`node /opt/orbit/cli/orbit.js …`, `Dockerfile:116, 203-210`); it is not on
  the operator's PATH. Anything an operator runs post-install goes through
  `docker compose exec`.

## Decision

### 1. The claim code

At the end of `registerNode`, if `instance_authority` has no row, the process
generates 32 random bytes, keeps them **in process memory only**, and writes
the claim notice to stdout as the final act of start-up:

    Orbit is not yet claimed. Open this link to create the first administrator:
      https://orbit.example.org/#claim=ABCD-EFGH-…   (52 characters, base32, groups of four)
    or enter the code by hand on the sign-in screen: ABCD-EFGH-…

Rules:

- The code is rendered as base32 in groups of four (case-insensitive on
  entry; whitespace and hyphens ignored). Length no longer matters because
  the link carries it.
- The code is in the **URL fragment** (`#claim=…`), never a query string:
  browsers do not send fragments, so reverse proxies, access logs and
  `Referer` headers never see it. The door reads `location.hash`, clears it
  with `history.replaceState`, and POSTs the code.
- The notice is written by a dedicated `printClaimNotice()` that bypasses
  `operationalDetail` on purpose (text form above; in `ORBIT_LOG_FORMAT=json`
  one JSON object `{"event":"bootstrap.claim","url":…,"code":…}`) and is the
  only place in Orbit that prints a secret. The bypass is commented with this
  ADR's number.
- Regenerated on every boot while unclaimed; the previous value is gone with
  the old process. "I lost the code" is answered by `docker compose restart
  orbit-app` and reading the log again.
- Inert once `instance_authority` exists: the code is not consulted, and a
  claimed instance never prints a notice. The value is never written to the
  database, to a file, or into any operational-log record.
- Nothing is generated when `instance_authority` exists at boot, so a
  restored backup (which carries the authority row) never prints a code.

### 2. Claiming

The instance is **unclaimed** while `instance_authority` has no row. While
unclaimed:

- `POST /api/auth/bootstrap/claim { claim }` compares the normalised input
  with the in-memory value using `constantTimeEqual`, behind the verification
  gate and the same backoff schedule as sign-in, held **in process memory**
  beside the code (revised at build, 2026-09-09: the first draft said a
  persisted row keyed on the literal `bootstrap`, but migration 0038 has no
  table that can hold one, and a restart replaces the code the counter
  guards, so a counter with the same lifetime loses nothing). Success mints a sealed cookie `__Secure-orbit-claim` (JWE,
  audience `bootstrap-claim`, **5 minute** TTL). Failure is the generic
  `bootstrap_invalid`.
- `GET /api/auth/login` (the OIDC start) requires that cookie and seals
  `bootstrap: true` into the login transaction, so the callback learns the
  claim from a value the browser cannot forge.
- `POST /api/auth/bootstrap/local { email, displayName, password }` requires
  the cookie and, in one transaction under `INSTANCE_BOOTSTRAP_LOCK_KEY`
  (the `orbit:first-administrator` literal promoted to
  `src/lib/auth/authority-locks.ts`), creates the user as instance
  administrator, the local credential, the `instance_authority` row,
  `user_preferences`, and the audit record `instance_claimed`; the response
  carries a session.
- No other route creates a user. Anonymous visitors see the claim card and
  nothing else.

Once claimed, every bootstrap route answers `bootstrap_claimed` regardless
of cookie. Single use is enforced by state. The cookie TTL is 5 minutes to
match the recovery link (§5): the operator has just clicked the link and is
at the keyboard, and if the cookie lapses mid-way (a slow provider sign-up,
say) the remedy is one more click on the same link, because the code stays
valid until the next restart. A longer window bought nothing and left a
second number to explain.

The concurrency case is the one #263 already serialises: two claimants with
valid cookies race under the same lock; the second finds the authority row
and gets `bootstrap_claimed`.

### 3. Fail closed

If the process cannot generate the code (entropy failure — practically
never) it exits non-zero like any other start-up fault, with one bounded
record `{state: "blocked", reason: "configuration_invalid", setting:
"authentication", action: "check_configuration", impact: "sign_in_blocked"}`.
There is no "unclaimed but unclaimable" state: an unclaimed instance that is
up always has a live code.

### 4. Rotation

Restart the container. There is no command, file or key: the code has no
storage to rotate.

### 5. Lost-administrator recovery after the claim

The recovery path is a **one-time setup link for the primary
administrator**, minted from the deployment host:

    docker compose --env-file .env-orbit exec orbit-app \
      node /opt/orbit/cli/orbit.js auth recovery-link

The command reads `instance_authority`, creates a `credential_setup_tokens`
row for the primary user (purpose `recovery`, **5 minute** expiry — the
owner's words: an administrator doing this should be doing it instantly —
single use, sha256 digest at rest like invitation tokens in
`src/server/invitations/token.ts`), revokes that user's sessions, writes the
audit record `recovery_link_issued`, and prints one URL to the terminal. It
prints nothing to the container log. Opening the link sets (or replaces) the
primary administrator's local password and signs them in.

This covers every lost-access case with one mechanism: a forgotten local
password, and a primary administrator who only ever used OIDC and has lost
the provider. It never touches `is_instance_admin`, never moves
`instance_authority`, and so cannot bypass the last-administrator or
primary-administrator invariants (#263). Administrators reset **other**
local users through the same token table from the administration screen
(ADR-0023); the CLI exists only because the primary administrator has nobody
above them.

### 6. What the trust boundary is, said plainly

**Whoever can read the container's log while the instance is unclaimed can
claim it.** That includes anyone with `docker logs` on the host and any
log-shipping destination the operator has attached to the container. After
the claim the code is worthless. Anyone who can run `docker compose exec` on
the host can recover the primary administrator at any time. The operator
documentation states both in those words, and tells operators who ship logs
to claim before attaching the shipper or to accept that the shipper's
readers could have claimed first.

## Consequences

- #259's acceptance line is reworded (owner, 2026-09-09): "The bootstrap
  proof is generated at boot while the instance is unclaimed, appears only in
  the container's own log (as link and code), is regenerated on restart and
  is inert once claimed; it never enters shell history, the database or
  shipped application records."
- The installer's contract changes: a fresh install is secure with no
  provider configured; its completion screen tells the operator to run
  `docker compose logs orbit-app` and open the last line. No new secret file,
  Compose secret or configuration key.
- The claim never being in the database means a database backup never
  contains a live claim, and restoring a backup into another deployment does
  not hand that deployment over.
- The e2e harness stops relying on the race: `claimInstanceAsAdministrator`
  reads the notice from the acceptance stack's own log (`docker compose -p
  $COMPOSE_PROJECT_NAME logs orbit-app`; `v19-tour.spec.ts` already asks the
  stack questions this way) and performs the claim deterministically. It is
  idempotent: if `availability.claimed` is already true it signs in as the
  fixture administrator as before. No test-only hook goes into the shipped
  image; the helper exercises the same path an operator uses.
- Recovery needs shell access to the host. Self-service email reset is out
  of scope (a new attack surface, argued on its own issue if wanted).

## Alternatives rejected

- **Installer-generated secret file in `.orbit-secrets`** (the 2026-08-16
  ruling, and this record's first draft): a Compose secret, a canonical
  runtime path, a configuration key, an entrypoint staging step, a
  `--set-bootstrap-claim` verb and installer-guarantee entries, all to move
  the code from the log to a file the operator opens in a viewer and types
  from. The owner judged the extra machinery not worth the difference in
  exposure and preferred a link that can be clicked. Superseded 2026-09-09.
- **Time window after first start**: a scanner beats a human reading docs;
  restarting reopens the window to the attacker too. Kept only as the 5
  minute cookie TTL on an already-authenticated claim.
- **Trusted-local source (loopback / RFC 1918)**: Orbit deliberately trusts
  no `X-Forwarded-*` header and every request behind a reverse proxy looks
  local. Would need a trusted-proxy contract first.
- **Code in a query string**: query strings reach proxies, access logs and
  `Referer`; the fragment reaches only the page.
- **Pre-seeded administrator email**: overloads email as identity, which #259
  forbids.
- **Recovery by re-printing a claim**: the claim is refused once the instance
  is claimed; an "unclaim" path would be a second way to seize the instance.
- **Test-only claim override** (fixed code via environment variable): a knob
  in the shipped image that turns the claim into a guessable constant.
  Reading the log is cheap and is the real path.

## Superseded

- Ruling 2 of 2026-08-16 (secret file, filesystem access required) —
  replaced by the owner on 2026-09-09 with the log-line claim above.
- The `instance_authority` table proposed in the 2026-08-16 plan note was
  delivered by #263 in a narrower shape (no `registration_policy`,
  `local_sign_in_enabled` or `claimed_method` columns); this record uses the
  table as delivered. Registration policy is fixed by ADR-0023 and needs no
  column.
- The plan's `GET /api/auth/bootstrap` route is folded into the existing
  signed-out `GET /api/auth/availability` (`claimed` and `methods` fields).
