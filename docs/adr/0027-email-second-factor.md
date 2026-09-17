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
