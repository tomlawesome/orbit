# ADR-0027: Every password sign-in is completed by an emailed approval link

**Status:** Accepted (owner rulings of 2026-09-16 on #1033)
**Date:** 2026-09-16
**Relates to:** #1033 (email second factor); ADR-0023 (registration and
recent authentication — unchanged by this); `docs/authentication.md`

## Context

A local account is a password and nothing else; whoever holds the password
holds the account, and Orbit holds personal data. The step-up guard
(ADR-0023 §5) proves the same person is still present; it does not prove a
second thing. The owner chose email as that second thing — not a TOTP app,
not SMS — because every Orbit account already depends on a working mailbox
for setup and recovery.

## Decision

1. **Every password sign-in**, every time, is completed by a link sent to
   the account's email. No remembered-browser exemption: Orbit holds
   personal data, so a stolen cookie must not be worth a second factor.
2. **Everyone, always on, required.** No per-user switch. The factor is off
   as a whole only when the instance has no mail relay configured, and the
   settings screen says so plainly.
3. **OIDC sign-ins are not challenged.** The provider is the identity and
   handles its own second factor; Orbit cannot see it and does not
   double-prompt.
4. **The link approves a pending sign-in; it does not itself sign anyone
   in.** The tab that entered the password waits. The link opens a page
   that shows what is being approved — instance, browser, rough location
   or address, time — with one **Approve** button and one **This wasn't
   me** button. Approving lets the waiting tab through; the page that
   approved is not signed in. A forwarded link therefore approves only if
   the reader chooses to, having read what it is for.
5. **The email says what it authorises**, in short bullets, before the
   link: sign in to Orbit at *instance*, from *browser*, at *time*; if this
   wasn't you, ignore it — nobody gets in without approval.
6. **Token shape** follows the recovery link: 32 random bytes, stored as a
   SHA-256 hash, single use, 10 minutes, bound to the pending sign-in.
7. **Undeliverable mail:** an instance administrator can issue a one-time
   sign-in link from the admin screen, the `setup_link_issue` path that
   already exists for recovery.
8. **Send limits:** one live link per pending sign-in; resend after 60 s;
   five sends per account per hour, then "check the mail we already sent".
   Failed attempts count in the existing per-credential backoff.

## Consequences

- Sign-in becomes two screens: password, then "check your email" with a
  resend button; the tab proceeds on its own once approved.
- A new `signInApprovals` table (pending sign-in, token hash, expiry,
  consumed, approved) and one new mail template.
- A recorded "this wasn't me" revokes the pending sign-in and is worth
  surfacing to the account holder on their next successful sign-in.
- A mail outage locks the door for everyone with a password; the admin
  link is the only way through. That is accepted, and is why the factor
  switches off as a whole when no relay is configured.

## Rulings of 2026-09-18

Added when #1033 was built. The first list is the owner's; the second is the
set of calls the build had to make to carry it out, recorded here so the next
reader finds them beside the decision rather than in a merge request.

**Ruled (owner, 2026-09-18):** setup and recovery links count as the factor —
getting in through one sends no approval email, and the approval link uses the
same email route as the setup link. No-email accounts do not exist (email is
mandatory) — build no branch for them. Show the requester's IP address on the
approval page and in the mail; a private (LAN) address reads *from your home
network*; take the client address from the forwarded-for header only when the
request came from the instance's own proxy (look at how the app is fronted in
`compose/` and what SvelteKit's `getClientAddress` returns under it — if there
is no existing proxy-trust convention, use `event.getClientAddress()` and note
it). Country flag / named location are #1053, NOT this build.

**Settled at build time (Fable, 2026-09-18):** opening the link never approves
anything — only pressing Approve or This wasn't me changes state (mail scanners
follow links). Only the browser that typed the password can collect the
session: the waiting tab holds a short-lived cookie tied to its pending
sign-in; polling without it gets nothing. The approval page is a phone screen
first: one column, Approve full-width on top, This wasn't me the same size
beneath in a quieter colour. "Relay configured" means the SMTP settings are
present, not that the server answers now. A refused sign-in shows the waiting
tab "this sign-in was refused", counts as a failed attempt in the existing
per-credential backoff, and leaves a one-line notice on the sky at the next
successful sign-in (when, and a link to change the password).

### What the build settled about the client address

Orbit is fronted by nothing: `docker-compose.yml` publishes the application's
own port, and the only proxy in the repository belongs to the disposable demo
stack. There is therefore no proxy-trust convention to honour, and no
forwarded-for header this instance has any reason to believe — so the address
is `event.getClientAddress()`, noted here as the ruling asks. An operator who
puts a reverse proxy in front of Orbit will need that convention before the
address on the approval page means what it says.
