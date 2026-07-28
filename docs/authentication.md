# Authentication and Authentik setup

Orbit is an OpenID Connect relying party. It uses provider discovery and does not contain provider-specific authentication code; Authentik is the primary supported configuration.

## Authentik provider

In the Authentik Admin interface:

1. Open **Applications → Applications**, create the Orbit application, and add an **OAuth2/OIDC** provider.
2. Set **Client type** to **Confidential** and enable the **Authorization code** grant.
3. Add the Orbit callback as a **Strict** redirect URI. For local development this is `http://127.0.0.1:3000/api/auth/callback`; for production it is `https://your-orbit-host/api/auth/callback`.
4. Include the standard `openid`, `profile`, and `email` scope mappings.
5. Keep the recommended per-provider issuer mode. With an application slug of `orbit`, the issuer is normally `https://auth.example.com/application/o/orbit/`.
6. Select an asymmetric **Signing key**, such as Authentik's self-signed certificate. Orbit intentionally accepts asymmetric ID-token algorithms only and validates them against the provider's JWKS.
7. Select a stable, non-email subject mode, such as a hashed user ID or user UUID. Changing this setting later creates a new Orbit identity from the application's perspective.

Copy the provider's client ID and secret into the Orbit environment:

```env
APP_URL=http://127.0.0.1:3000
SESSION_SECRET=replace-with-a-unique-random-value-of-at-least-32-characters
OIDC_ISSUER=https://auth.example.com/application/o/orbit/
OIDC_CLIENT_ID=your-authentik-client-id
OIDC_CLIENT_SECRET=your-authentik-client-secret
OIDC_CALLBACK_URL=http://127.0.0.1:3000/api/auth/callback
OIDC_SCOPES=openid profile email
```

The issuer, including its path and trailing slash, must exactly match the `issuer` value in Authentik's discovery document. The callback must exactly match the strict redirect URI. Keep `APP_URL`, `OIDC_CALLBACK_URL`, and the address used in the browser consistent; `localhost` and `127.0.0.1` are different hosts.

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
- the standard `sub` claim and a usable email claim in either the ID token or UserInfo response.

Custom claim names can be configured with `OIDC_EMAIL_CLAIM`, `OIDC_EMAIL_VERIFIED_CLAIM`, `OIDC_NAME_CLAIM`, and `OIDC_AVATAR_CLAIM`.

Orbit maps accounts only by the immutable `(issuer, subject)` pair. It updates mutable profile information on subsequent sign-ins, but it never merges users merely because their email addresses match.

## Household membership

Every household has one owner and zero or more members. Owners add an existing registered Orbit user by selecting the user&apos;s display name; Orbit sends the immutable internal user ID to the server and does not expose other users&apos; email addresses in the membership interface. There is no invitation or email-token workflow.

Membership and owner checks are repeated by every household-scoped API. Client-side controls are only a convenience and are never treated as authorization.

## Application endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/login?returnTo=/path` | Starts sign-in and redirects to the provider. |
| `GET` | `/api/auth/callback` | Validates the provider response and establishes a session. |
| `GET` | `/api/auth/session` | Returns the current user, expiry, household context, and CSRF token. |
| `POST` | `/api/auth/session/refresh` | Rotates the local session after origin and CSRF validation. |
| `POST` | `/api/auth/logout` | Invalidates the local session and redirects through provider logout when advertised. |
| `GET` | `/api/workspace` | Returns the caller&apos;s authorized households and records. |
| `POST` | `/api/workspace/commands` | Applies one validated, authorized workspace mutation. |
| `PUT` | `/api/preferences` | Saves the caller&apos;s appearance preferences. |
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

- Sign-in uses random state, nonce, and a 256-bit PKCE verifier. The short-lived login transaction is authenticated and encrypted in an HTTP-only, same-site cookie.
- Discovery metadata must exactly match the configured HTTPS issuer. Provider endpoints must also use HTTPS.
- ID-token signature, issuer, audience, expiry, nonce, authorized party, and access-token hash are validated where applicable.
- Provider access and ID tokens are used only to complete the callback and are not persisted.
- The browser receives a random opaque session credential. Only its SHA-256 hash is stored in PostgreSQL.
- Session refresh rotates the credential atomically. Logout deletes it server-side and expires the cookie.
- State-changing session actions require an exact same-origin request and a session-bound HMAC synchronizer token.
- Production cookies use `Secure`, `HttpOnly`, `SameSite=Lax`, and the `__Host-`/`__Secure-` prefixes where their path constraints permit.

## Troubleshooting

- `auth_not_configured`: verify every required environment variable and use at least 32 characters for `SESSION_SECRET`.
- `discovery_failed`: compare `OIDC_ISSUER` exactly with the provider discovery document and confirm every advertised endpoint uses HTTPS.
- `invalid_state`: restart sign-in without reusing a callback URL; also check that the browser host did not change during the flow.
- `invalid_id_token`: select an asymmetric signing key, confirm the configured client ID, and check server clock accuracy.
- `missing_email`: enable the provider's email scope mapping or set `OIDC_EMAIL_CLAIM` to the actual claim name.
- Redirect URI error at the provider: configure the callback as a strict redirect and make its scheme, host, port, and path identical to `OIDC_CALLBACK_URL`.
