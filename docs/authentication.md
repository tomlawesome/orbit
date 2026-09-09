# Authentication

Every Orbit account is a local password, a linked OpenID Connect (OIDC)
identity, or both. Local accounts are the baseline and are always available.
OIDC is optional: one deployment sets `ORBIT_AUTH_OIDC=true` to turn it on, and
Orbit uses provider discovery with no provider-specific code; Authentik is the
primary supported configuration. Turning `ORBIT_AUTH_OIDC` back to `false`
switches sign-in with a provider off without deleting the provider's
configuration, so it can be turned back on later with no re-entry.

## Claiming a fresh install

A fresh instance has no administrator and is **unclaimed**. At the end of
start-up, while unclaimed, Orbit generates a one-time claim code, keeps it only
in that process's memory, and prints it as the last line of the container's
own log — both as a clickable link and as a plain code:

```sh
docker compose --env-file .env-orbit logs orbit-app
```

Open the link on the last line (or type the code by hand on the sign-in
screen) to create the first administrator, with a password, an OIDC sign-in,
or both. The installer never sees this code and never creates the first
administrator itself; it only tells the operator where to look. The code is
regenerated on every restart and is inert once an administrator exists — a
claimed instance never prints one. If the code is lost, `docker compose
restart orbit-app` and read the log again.

Said plainly, from [ADR-0022](adr/0022-bootstrap-claim-and-lost-administrator-recovery.md) §6:

> **Whoever can read the container's log while the instance is unclaimed can
> claim it.**

That includes anyone with `docker logs` access on the host and any
log-shipping destination the operator has attached to the container. After the
claim the code is worthless. Anyone who can run `docker compose exec` on the
host can recover the primary administrator at any time (see "Recovering the
primary administrator" below) — that is the same trust boundary, not a
separate gap. An operator who ships container logs off the host should claim
the instance before attaching the shipper, or accept that the shipper's
readers could have claimed first.

## Local-only mode

`ORBIT_AUTH_OIDC=false` is the default. In this mode Orbit never contacts an
identity provider: every account signs in with an email address and a
password, and the sign-in screen shows only that form. This is a complete,
supported way to run Orbit — nothing about local-only mode is a reduced or
temporary state.

## Adding OIDC later

Local-only and OIDC are not a one-time choice. To turn OIDC on for an existing
instance, run guided configuration again and choose the identity-provider
option, or set the fields by hand and flip the key:

```sh
bash scripts/configure.sh --init
bash scripts/configure.sh --set-oidc-secret
bash scripts/configure.sh --check
```

`--init` asks "Sign in with local accounts only, or also with an identity
provider?" and, when the answer is "also", collects the public Orbit origin,
the provider's issuer URL and the client ID, and derives the callback URL.
`--set-oidc-secret` reads the provider's client secret directly from the
terminal (never as a command argument) and stores it file-backed under
`.orbit-secrets/`. `--check` confirms readiness without printing any value.
Restart Orbit to apply the change. Existing local accounts are unaffected:
OIDC sign-in becomes available alongside them, and any user may then link a
provider identity to their account (see "Linking and unlinking" below).

Once OIDC is enabled, a successful sign-in from a `(issuer, subject)` pair
Orbit has not seen before creates a new Orbit account automatically, unless
the email already belongs to an existing account — that sign-in is refused
with a fixed message telling the person to sign in to their existing account
and link the provider from settings instead. There is no other form of
self-registration.

## Linking and unlinking

A signed-in user manages their own sign-in methods from **Settings → Sign-in
methods**: a password (set, changed date, and actions to change or remove it)
and each linked identity provider (issuer, linked date, and an action to
unlink it). When OIDC is enabled and not yet linked, a "Link your identity
provider" action is offered. Every one of these actions requires recent
authentication (below), and removing the last usable method is refused so an
account can never be locked out of itself.

## Administrator: adding a local user

An instance administrator creates a local user from **Administration → Users**
by entering their email, display name, and how long the setup link should
stay valid — 1 to 14 days, defaulting to 7. Orbit **emails the setup link to
that address**; it is never shown to the administrator, never appears in the
user list, and never appears in any API response. The new user opens the
link, chooses a password, and is signed in.

This means outbound mail is a prerequisite for adding local users: **an
instance with no working SMTP configured cannot add a local user**, because
there is nowhere else the link can go. This is the same limit household
invitations already carry (see [administrator
operations](administrator-operations.md#mailbox-provider-operation) for SMTP
setup). If sending fails, the administrator sees a bounded reason and a Retry
action; the account already exists, so retrying re-sends rather than
recreating it. Re-issuing a link (from the user's row, "Send a new setup
link" — used for both a lost first-setup link and an ordinary forgotten
password) invalidates any earlier one for that user; only the newest link
works.

## Recovering the primary administrator

The primary administrator has nobody above them to reset their password or
re-issue their setup link from the administration screen, so they get a
separate recovery path run from the deployment host:

```sh
docker compose --env-file .env-orbit exec orbit-app \
  node /opt/orbit/cli/orbit.js auth recovery-link
```

This is needed for exactly the same two cases as any other local user's
recovery — a forgotten password, or a lost OIDC identity — except that
nobody else can issue the link for the primary administrator, so the command
runs where the operator already has trusted access: the deployment host
itself. It prints exactly one URL to the terminal, nothing else, and writes
nothing to the container log. Opening it sets a new password and signs the
primary administrator in. The link expires 5 minutes after issue — an
administrator running this command should be doing it immediately — and a
stale or already-used link answers the same generic `setup_token_invalid` as
any other setup link. Running it also signs the primary administrator out of
every device they were previously signed into, and records a
`recovery_link_issued` audit entry. It never changes who the primary
administrator is.

## Recent authentication (step-up)

Every sensitive action — setting or changing a password, linking or
unlinking a sign-in method, re-issuing another user's setup link, and
transferring primary-administrator authority — always re-challenges the
person taking it, regardless of how recently they signed in. There is no
freshness window: a session left open at an unlocked screen is never itself
enough to take one of these actions.

- A user with a local password re-enters it inline, next to the action. It is
  checked under the same backoff and pacing as ordinary sign-in.
- A user with only an OIDC identity is sent to the provider with `max_age=0`,
  forcing a fresh provider sign-in, and Orbit requires the returned `auth_time`
  to be no more than about 60 seconds old. A provider that cannot do this
  fails the action closed with `step_up_failed` rather than allowing it
  through — that is the correct direction for that failure.
- The resulting proof is bound to the session and the specific action, is
  spent the moment it is used, and cannot be replayed even within its short
  (120 second) life.

## Signing out, plainly

"Sign out of every device" ends every session Orbit itself issued. It cannot
end a session at the identity provider. If a user signs out of Orbit
everywhere and the identity provider still remembers them, the very next OIDC
sign-in can seat them again with no further prompt — that is a property of
the provider, not something Orbit can override, and Orbit deliberately does
not depend on a provider behaviour (`prompt=login`) it cannot guarantee. A
user who wants to be fully signed out everywhere needs to sign out of the
identity provider too.

Restoring an earlier backup is a different, stronger boundary: a restore
replaces the whole database with an earlier point in time, so a session that
did not exist yet at that point never comes back. Local credentials and setup
tokens present at backup time restore intact; sessions created after that
point do not survive the restore. `scripts/test-backup-restore.sh` asserts
this every time the drill runs (see
[installer-guarantees.md](installer-guarantees.md)).

## Authentik provider

In the Authentik Admin interface:

1. Open **Applications → Applications**, create the Orbit application, and add an **OAuth2/OIDC** provider.
2. Set **Client type** to **Confidential** and enable the **Authorization code** grant.
3. Add the Orbit callback as a **Strict** redirect URI. For production use `https://orbit.your-domain.tld/api/auth/callback`. Loopback development may instead use `http://127.0.0.1:3000/api/auth/callback`.
4. Include the standard `openid`, `profile`, and `email` scope mappings.
5. Keep the recommended per-provider issuer mode. With an application slug of `orbit`, the issuer is normally `https://auth.example.com/application/o/orbit/`.
6. Select an asymmetric **Signing key**, such as Authentik's self-signed certificate. Orbit intentionally accepts asymmetric ID-token algorithms only and validates them against the provider's JWKS.
7. Select a stable, non-email subject mode, such as a hashed user ID or user UUID. Changing this setting later creates a new Orbit identity from the application's perspective.

The guided configuration commands and their contract are in "Adding OIDC
later" above. The resulting production settings have this shape:

```env
ORBIT_AUTH_OIDC=true
APP_URL=https://orbit.your-domain.tld
OIDC_ISSUER=https://sso.your-domain.tld/application/o/orbit/
OIDC_CLIENT_ID=your-authentik-client-id
OIDC_CLIENT_SECRET=
OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret
OIDC_CALLBACK_URL=https://orbit.your-domain.tld/api/auth/callback
OIDC_SCOPES=openid profile email
```

The supported Compose deployment mounts the persistent host file read-only,
copies it into Orbit's private runtime tmpfs with Orbit-user ownership and mode
`0400`, and exposes only the runtime path to the application. Existing
direct-value configuration remains readable for upgrade compatibility, but
direct and file-backed forms are mutually exclusive. Re-running the secret
command safely replaces the file; ordinary configuration and recognised
upgrades preserve it.

The issuer, including its path and trailing slash, must exactly match the `issuer` value in Authentik's discovery document. The callback must exactly match the strict redirect URI. Keep `APP_URL`, `OIDC_CALLBACK_URL`, and the address used in the browser consistent; `localhost` and `127.0.0.1` are different hosts.

For loopback development only, use `http://127.0.0.1:3000` for `APP_URL`
and `http://127.0.0.1:3000/api/auth/callback` for the callback. Do not use
plain HTTP, loopback names, or documentation placeholder domains for a real
deployment.

Authentik currently reports `email_verified` independently of the `email` claim. Orbit requires a usable email address but does not pretend an unverified address is verified: it records the claim as supplied and can use that status for future policy decisions.

Relevant Authentik references:

- [Create an OAuth2 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/create-oauth2-provider)
- [OAuth2/OIDC provider settings and endpoints](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)

## Generic OIDC providers

A provider must support:

- OpenID Connect discovery over HTTPS;
- Authorization Code flow with S256 PKCE, explicitly advertised as supported in
  the provider discovery document;
- confidential-client authentication using `client_secret_basic`;
- an asymmetrically signed ID token and a published JWKS;
- exact issuer and audience validation;
- the standard `sub` claim and a usable email claim in either the ID token or UserInfo response;
- an `auth_time` claim honouring `max_age=0`, for the step-up re-challenge above.

Custom claim names can be configured with `OIDC_EMAIL_CLAIM`, `OIDC_EMAIL_VERIFIED_CLAIM`, `OIDC_NAME_CLAIM`, and `OIDC_AVATAR_CLAIM`.

Orbit maps accounts only by the immutable `(issuer, subject)` pair. It updates mutable profile information on subsequent sign-ins, but it never merges users merely because their email addresses match.

## Household membership

Every household has one owner and zero or more members. Owners add an existing registered Orbit user by selecting the user&apos;s display name; Orbit sends the immutable internal user ID to the server and does not expose other users&apos; email addresses in the membership interface. There is no invitation or email-token workflow.

Membership and owner checks are repeated by every household-scoped API. Client-side controls are only a convenience and are never treated as authorization.

## Application endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/availability` | Signed-out: whether the instance is claimed and which sign-in methods are offered. Reveals nothing about accounts. |
| `POST` | `/api/auth/bootstrap/claim` | Verifies the claim code and sets a short-lived claim cookie. |
| `POST` | `/api/auth/bootstrap/local` | Creates the first administrator with a password, under the claim cookie. |
| `POST` | `/api/auth/local/login` | Signs a local user in with email and password. |
| `GET` | `/api/auth/login?returnTo=/path` | Starts OIDC sign-in and redirects to the provider (`auth_not_configured` when OIDC is off). |
| `GET` | `/api/auth/callback` | Validates the provider response and completes sign-in, bootstrap, linking, or step-up, depending on what started the transaction. |
| `GET` | `/api/auth/session` | Returns the current user, expiry, household context, and CSRF token. |
| `POST` | `/api/auth/session/refresh` | Rotates the local session after origin and CSRF validation. |
| `POST` | `/api/auth/logout` | Invalidates the local session and redirects through provider logout when advertised. |
| `POST` | `/api/auth/sessions/revoke` | Ends every session the caller holds, including the calling device, and clears its cookie (see "Signing out, plainly"). |
| `GET` | `/api/auth/methods` | The caller's own sign-in methods: password set/changed, and linked providers. |
| `POST` | `/api/auth/local/password` | Sets or changes the caller's password, behind recent authentication. |
| `POST` | `/api/auth/local/setup` | Consumes a setup or recovery token, sets a password, and signs the user in. |
| `POST` | `/api/auth/link/oidc/start` | Starts linking an OIDC identity to the signed-in account, behind recent authentication. |
| `POST` | `/api/auth/step-up/start` | Starts a step-up re-challenge with the provider for an OIDC-only user. |
| `DELETE` | `/api/auth/methods/local`, `/api/auth/methods/oidc/:identityId` | Removes a sign-in method, refused if it is the last one. |
| `POST` | `/api/admin/users` | Administrator: creates a local user and emails the setup link. |
| `POST` | `/api/admin/users/:userId/setup-link` | Administrator: re-issues and re-sends a setup or recovery link. |
| `GET` | `/api/workspace` | Returns the caller&apos;s authorized households and records. |
| `POST` | `/api/workspace/commands` | Applies one validated, authorized workspace mutation. |
| `PUT` | `/api/preferences` | Saves the caller&apos;s appearance preferences. |
| `GET/PUT` | `/api/settings/reminders` | Reads or saves the caller&apos;s own reminder timing and reports the instance&apos;s outbound-mail state. |
| `GET/POST/DELETE` | `/api/households/:id/members` | Lists or changes direct household membership. |
| `POST/DELETE` | `/api/push/subscriptions` | Registers or revokes the caller&apos;s browser push subscription. |

The `returnTo` parameter accepts application-relative paths only. Authentication and session responses are explicitly non-cacheable.

To call a state-changing endpoint, first request `/api/auth/session`, then send its `csrfToken` in the `X-CSRF-Token` header. The browser also sends the HTTP-only session cookie automatically:

```ts
const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
const session = await sessionResponse.json();

await fetch("/api/auth/session/refresh", {
  method: "POST",
  headers: { "X-CSRF-Token": session.csrfToken },
});
```

## Security model

- Local passwords are hashed with Argon2id and verified through an in-process
  concurrency gate so a burst of sign-in attempts cannot exhaust the host;
  failures are timed alike whether the email is unknown, the password is
  wrong, or the account has no credential, so none of the three is
  distinguishable from outside. Failed attempts are backed off per credential
  (five free attempts, then a doubling lockout up to 15 minutes) and the
  counter is a database row, so a restart does not reset it.
- OIDC sign-in uses random state, nonce, and a 256-bit PKCE verifier. The
  short-lived login transaction is authenticated and encrypted in an
  HTTP-only, same-site cookie.
- Discovery metadata must exactly match the configured HTTPS issuer. Provider endpoints must also use HTTPS.
- ID-token signature, issuer, audience, expiry, nonce, authorized party, and access-token hash are validated where applicable.
- Provider access and ID tokens are used only to complete the callback and are not persisted.
- The browser receives a random opaque session credential. Only its SHA-256 hash is stored in PostgreSQL. Setup and recovery tokens are stored the same way: only their SHA-256 hash, never the token itself.
- Session refresh rotates the credential atomically. Logout deletes it server-side and expires the cookie.
- State-changing session actions require an exact same-origin request and a session-bound HMAC synchronizer token.
- Production cookies use `Secure`, `HttpOnly`, `SameSite=Lax`, and the `__Host-`/`__Secure-` prefixes where their path constraints permit.
- Local users are enumerable by nobody outside the administrator user list:
  every sign-in failure is one word, one status, one cost, regardless of
  which of the three causes produced it.

## Troubleshooting

- Run `bash scripts/configure.sh --check` first. It identifies missing or
  inconsistent configuration by field name without displaying values.
- `auth_not_configured`: for OIDC routes, this means `ORBIT_AUTH_OIDC` is not
  `true`, or the provider fields fail readiness while it is. Verify every
  required authentication field and ensure exactly one direct or `_FILE` form
  is configured for each secret. For the supported OIDC path, rerun `bash
  scripts/configure.sh --set-oidc-secret` and then the value-free readiness
  check; a missing, empty, non-regular or symbolic-link secret is rejected
  without displaying its contents.
- `bootstrap_required`: the instance is unclaimed and no valid claim cookie is
  present — read the claim link from `docker compose logs orbit-app` (see
  "Claiming a fresh install").
- `bootstrap_invalid` / `bootstrap_claimed`: the entered code was wrong, or the
  instance is already claimed.
- `credentials_invalid`: the email, password, or account state did not match —
  Orbit does not say which, on purpose.
- `too_many_attempts`: the credential is temporarily locked from repeated
  failures; wait for the backoff to clear.
- `recent_authentication_required` / `step_up_failed`: the action needs a
  fresh password or provider challenge (see "Recent authentication" above).
- `link_required`: an OIDC sign-in matched an existing account's email; sign in
  to that account and link the provider from Settings instead.
- `link_exists`: the provider identity is already linked to a different
  account.
- `link_last_method`: refused because it would remove the account's only
  remaining sign-in method.
- `setup_token_invalid`: the setup or recovery link was already used, has
  expired, or does not exist — ask the administrator (or, for the primary
  administrator, run `orbit auth recovery-link`) to issue a new one.
- `discovery_failed`: compare `OIDC_ISSUER` exactly with the provider discovery document and confirm every advertised endpoint uses HTTPS.
- `invalid_state`: restart sign-in without reusing a callback URL; also check that the browser host did not change during the flow.
- `invalid_id_token`: select an asymmetric signing key, confirm the configured client ID, and check server clock accuracy.
- `missing_email`: enable the provider's email scope mapping or set `OIDC_EMAIL_CLAIM` to the actual claim name.
- Redirect URI error at the provider: configure the callback as a strict redirect and make its scheme, host, port, and path identical to `OIDC_CALLBACK_URL`.
