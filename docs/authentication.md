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
in that process's memory, and prints it in the container's own log, after the
usual start-up lines — both as a clickable link and as a plain code:

```sh
docker compose --env-file .env-orbit logs orbit-app
```

Open the claim link (or type the code by hand on the sign-in
screen) to create the first administrator, with a password, an OIDC sign-in,
or both. The installer never sees this code and never creates the first
administrator itself; it only tells the operator where to look. The code is
regenerated on every restart and is inert once an administrator exists — a
claimed instance never prints one. If the code is lost, `docker compose
restart orbit-app` and read the log again.

Said plainly: **whoever can read the container's log while the instance is
unclaimed can claim it.** That includes anyone with `docker logs` access on
the host and any log-shipping destination the operator has attached to the
container. After the claim the code is worthless. Anyone who can run
`docker compose exec` on the host can recover the primary administrator at any
time (see [Recovering the primary
administrator](administrator-operations.md#recovering-the-primary-administrator))
— that is the same trust boundary, not a separate gap. An operator who ships container logs off the host should claim
the instance before attaching the shipper, or accept that the shipper's
readers could have claimed first.

## Local-only mode

`ORBIT_AUTH_OIDC=false` is the default. In this mode Orbit never contacts an
identity provider: every account signs in with an email address and a
password, and the sign-in screen shows only that form. This is a complete,
supported way to run Orbit — nothing about local-only mode is a reduced or
temporary state.

## Every password sign-in is approved by email

Signing in with a password is two screens, not one. You type your email and
password, Orbit sends a link to the address on your account, and the tab you
typed in waits. Open the link — on your phone, or wherever your mail is — and
it shows you what is being approved:

- which Orbit, by its address
- which browser, roughly ("Chrome on Linux")
- where from: your own network reads **your home network**, anything else
  shows the address it came from
- when

Two buttons: **Approve** lets the waiting tab in, and **This wasn't me**
refuses it. Opening the link on its own does nothing at all — mail scanners
follow links, so only a press changes anything. The page you approve on is not
signed in, whichever you press: the browser that typed the password is the one
that gets in, and only that one.

This is on for everybody, every time. There is no per-user switch, no "trust
this browser" and no way to turn it off for one account. The one thing that
changes it is the instance: **with no outgoing mail configured, there is no
second factor at all**, because Orbit cannot ask for an approval it has no way
to send. Settings → Sign-in methods says which of the two your instance is.

**Signing in with an identity provider is not challenged.** The provider is
the identity and runs its own second factor; Orbit cannot see it and does not
ask a second time.

**Setup and recovery links are not challenged either — they are the factor.**
Opening one sets a password and signs you in with no approval mail, which is
also the way past a broken mailbox: if approval mail is not reaching somebody,
an administrator sends them a new setup link (Administration → the person's
row → "send a new setup link"), and that gets them in.

The link lasts ten minutes and works once. You can ask for another after a
minute, and up to five in an hour; past that, the answer is to read the mail
already sent. A refused sign-in counts as a failed attempt in the same backoff
a wrong password does, and leaves a one-line notice on your sky the next time
you do get in, with a link to change your password — somebody knew it.

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

## Administrator tasks

Two tasks for the administrator are described in
[Administrator operations](administrator-operations.md): [adding a local
user](administrator-operations.md#adding-a-local-user), and [recovering the
primary administrator](administrator-operations.md#recovering-the-primary-administrator)
from the deployment host.

## Recent authentication (step-up)

Every sensitive action — setting or changing a password, linking or
unlinking a sign-in method, re-issuing another user's setup link,
creating a system for somebody else, and writing out or bringing in a portable archive — always re-challenges the
person taking it, regardless of how recently they signed in. There is no
freshness window: a session left open at an unlocked screen is never itself
enough to take one of these actions.

- A user with a local password re-enters it inline, next to the action. It is
  checked under the same backoff and pacing as ordinary sign-in.
- A user with only an OIDC identity is sent back to the provider to sign in
  again. Orbit asks the provider for a fresh sign-in (it sends `max_age=0`)
  and accepts the result only if the provider says the sign-in happened
  within about the last 60 seconds. A provider that cannot do this refuses
  the action with `step_up_failed` rather than letting it through; refusing
  is the correct direction for that failure.
- The resulting proof is bound to the session and the specific action, is
  spent the moment it is used, and cannot be replayed even within its short
  (120 second) life.

With no usable encryption key, nobody signs in by any method, administrators
included: Orbit is locked until the key is fixed on the host (#1405; see
[administrator-operations.md](administrator-operations.md#restoring-the-document-key-encryption-key)).

## Signing out, plainly

Pressing sign out ends Orbit's session at once; the descent and the goodbye
play; then, for a session that began at the identity provider, the browser
goes to the provider's sign-out page carrying that session's ID token, so the
provider knows which of its sessions to end, and the provider brings the
browser back to `/logout`. A session that began with a password has no
provider session, so the journey ends at the goodbye. If the tab is closed
before the goodbye finishes, the provider's session stays alive; sign out
there too.

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
[installer-guarantees.md](installer-guarantees.md)). A restored backup brings
back the sessions it held, and signing one of those out may land on the
provider's error page because the provider no longer knows that token;
Orbit's session is still ended.

## Authentik provider

In the Authentik Admin interface:

1. Open **Applications → Applications**, create the Orbit application, and add an **OAuth2/OIDC** provider.
2. Set **Client type** to **Confidential** and enable the **Authorization code** grant.
3. Add the Orbit callback as a **Strict** redirect URI. For production use `https://orbit.your-domain.tld/api/auth/callback`. Loopback development may instead use `http://127.0.0.1:3000/api/auth/callback`.
4. Include the standard `openid`, `profile`, and `email` scope mappings.
5. Keep the recommended per-provider issuer mode. With an application slug of `orbit`, the issuer is normally `https://auth.example.com/application/o/orbit/`.
6. Select an asymmetric **Signing key**, such as Authentik's self-signed certificate. Orbit only trusts sign-in tokens it can check against the provider's published public keys (its JWKS); it deliberately refuses tokens signed with a shared secret.
7. Select a stable, non-email subject mode, such as a hashed user ID or user UUID. Changing this setting later creates a new Orbit identity from the application's perspective.
8. Add `https://orbit.your-domain.tld/logout` as a second **Strict** redirect URI, alongside the callback from step 3. Authentik checks the address Orbit asks it to return to after sign-out (`post_logout_redirect_uri`) against the provider's registered redirect URIs and refuses one it has not seen: without this entry, signing out ends on an Authentik error page instead of Orbit's goodbye. Orbit's own session is ended either way.


The settings this produces, in plain terms: Orbit sends the person to
Authentik to sign in, Authentik sends them back to Orbit's callback address
with a signed token, and Orbit checks that token's signature and contents
before it seats a session.

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
`0400`, and exposes only the runtime path to the application. A direct value
and the file-backed form are mutually exclusive. Re-running the secret
command safely replaces the file; ordinary configuration and recognised
upgrades preserve it.

The issuer, including its path and trailing slash, must exactly match the `issuer` value in Authentik's discovery document. The callback must exactly match the strict redirect URI. Keep `APP_URL`, `OIDC_CALLBACK_URL`, and the address used in the browser consistent; `localhost` and `127.0.0.1` are different hosts.

For loopback development only, use `http://127.0.0.1:3000` for `APP_URL`
and `http://127.0.0.1:3000/api/auth/callback` for the callback. Do not use
plain HTTP, loopback names, or documentation placeholder domains for a real
deployment.

Authentik currently reports `email_verified` separately from the `email`
claim (a claim is one named field inside the sign-in token). Orbit requires
a usable email address but does not pretend an unverified address is
verified: it records the claim as supplied and can use that status for
future policy decisions.

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

If the provider advertises an `end_session_endpoint`, register `<APP_URL>/logout`
as a post-logout redirect URI there. Orbit sends `id_token_hint` (the
session's own ID token) with every provider sign-out, as OpenID Connect
RP-Initiated Logout 1.0 describes.

Custom claim names can be configured with `OIDC_EMAIL_CLAIM`, `OIDC_EMAIL_VERIFIED_CLAIM`, `OIDC_NAME_CLAIM`, and `OIDC_AVATAR_CLAIM`.

Orbit maps accounts only by the immutable `(issuer, subject)` pair. It updates mutable profile information on subsequent sign-ins, but it never merges users merely because their email addresses match.

## Household membership

Every household has one owner and zero or more members. Owners add an existing registered Orbit user by selecting the user&apos;s display name; Orbit sends the immutable internal user ID to the server and does not expose other users&apos; email addresses in the membership interface. There is no invitation or email-token workflow.

Membership and owner checks are repeated by every household-scoped API. Client-side controls are only a convenience and are never treated as authorization.

## Security model

In short: Orbit keeps every sign-in secret on the server, never in the
browser; it checks that every request that changes something came from its
own pages; and it answers a failed sign-in with the same one word however it
failed, so nobody can learn which accounts exist. The detail behind that,
for readers who want to check it, is in
[Authentication internals](architecture.md#authentication-internals).

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
  expired, or does not exist — ask the administrator to issue a new one (for the primary administrator, see
  [Recovering the primary administrator](administrator-operations.md#recovering-the-primary-administrator)).
- `discovery_failed`: compare `OIDC_ISSUER` exactly with the provider discovery document and confirm every advertised endpoint uses HTTPS.
- `invalid_state`: restart sign-in without reusing a callback URL; also check that the browser host did not change during the flow.
- `invalid_id_token`: select an asymmetric signing key, confirm the configured client ID, and check server clock accuracy.
- `missing_email`: enable the provider's email scope mapping or set `OIDC_EMAIL_CLAIM` to the actual claim name.
- Redirect URI error at the provider: configure the callback as a strict redirect and make its scheme, host, port, and path identical to `OIDC_CALLBACK_URL`.
- Error page at the provider after signing out: `<APP_URL>/logout` is not registered on the provider, or the provider no longer recognises the session's token (a restored backup, a provider key rotation). Orbit's own session is already ended either way.
