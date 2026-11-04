# ADR-0041: The primary administrator removes a sign-in provider's links in one step, and everyone left with no password is mailed the existing setup link

**Status:** Accepted (owner verdicts on #1676, 2026-11-04)
**Date:** 2026-11-04
**Relates to:** #1676 (remove a sign-in provider); ADR-0022 (claim and
recovery); ADR-0023 (sign-in methods, recent authentication, setup links)

## Context

Turning a sign-in provider off (`ORBIT_AUTH_OIDC=false`) leaves every member's
link to it in `external_identities`. A member can remove their own link, but
nothing removes everyone's. Members whose only way in was that provider would
be left with no way to sign in.

ADR-0023 rejected email-based password reset: a public "forgot password" form
makes SMTP an authentication dependency and an enumeration surface. It did
not rule out an administrator sending a setup link to a known account, which
ADR-0022 and ADR-0023 already provide per person.

## Decision

1. **One action removes all links to a provider.** An administrator, on the
   Administration screen (not `repair.sh`; owner answer 45b), removes every
   member's link to one issuer. The rows are deleted, the provider sessions of
   those members end, and the audit entry carries counts only, no provider
   identifier. It is refused while that issuer is still the configured
   provider (`provider_still_configured`), or the next sign-in would link
   members again. The order the docs give: turn the provider off, remove the
   links, revoke the client at the provider.
2. **Members left with no password are mailed the existing setup link.** It is
   the administrator-issued setup link of ADR-0022/0023 (`sendSetupLink`), with
   a lifetime of 1 to 14 days, default 7. There is no new email type and no
   public self-service reset; ADR-0023's rejection stands. Without the mail
   option, the action refuses when anyone would be left with no way in
   (`provider_removal_strands_members`).
3. **Order: pre-flight, best-effort mail, commit.**
   - Pre-flight: work out who would be stranded. If nobody would be, no mail
     is needed. If someone would be and outgoing mail is not ready
     (`outgoingMailReady`), refuse before doing anything (`mail_not_ready`).
     A stranded member whose address cannot be read also refuses.
   - Mail: one member at a time, holding no lock, with a per-recipient record
     (mailed, or a bounded reason). A disabled member is never mailed and is
     recorded as `member_disabled`; their links still go.
   - Commit: in one locked transaction, re-read the stranded set, delete the
     links, end the provider sessions and write the audit. A failed mail does
     not undo the removal. A member stranded only since the pre-flight is
     recorded as not mailed (`stranded_after_check`).
4. **Only the primary administrator, with a local password, may do it.** Other
   administrators are refused (`primary_administrator_only`). A primary
   administrator with no password is refused with a request to set one in
   Settings (`primary_administrator_needs_password`). That check runs before
   the re-challenge, so they are told to set a password rather than refused a
   challenge they cannot pass. They are then re-challenged with their password
   (ADR-0023 §5, intent `provider_links_remove`).
5. **The result is a count plus exceptions.** It says how many were mailed and
   lists only members who could not be mailed or whose mail failed, each with
   its reason and "send again" (owner verdict 48).
6. **The screen (round 3, direction T "the one line", ratified 2026-11-04;
   50a and 51a kept).** A "Sign-in providers" card under People, beside Public
   contact, made only of parts the page already has.
   - One short row per removable provider (off, links left). A
     still-configured provider has no row, and with nothing removable there is
     no card.
   - The two people who cannot act, another administrator and the primary
     administrator with no password, see a quiet line in place of the button.
     The other-administrator line names the primary administrator; the
     no-password line links to Settings.
   - The confirm is the page's usual small form: password, then a two-tap
     button. No days field and no typed host; setup links last the default 7
     days.
   - The result names those not mailed, each with "send again". People rows
     carry no sign-in states.
   - The build target is
     `design/v19/provider-removal/round-3/t-the-one-line.html` (branch
     `design/1676-provider-removal`).

## Standard pattern

A pre-flight check, then best-effort notification with a per-recipient ledger
(an outbox record), before the destructive commit. The notification cannot be
rolled back, so it is done only after the checks that can refuse, and the
commit does not depend on it succeeding.

## Consequences

- Provider removal needs no new email type or public endpoint.
- A member whose mail fails is not rolled back; the administrator sees them in
  the result and sends the setup link again from their row.
- The primary administrator is signed out if they signed in through the
  provider; their password gets them back in.
- Outgoing mail must work for the removal to proceed when anyone is stranded.

## Alternatives rejected

- **A public "forgot password" reset**: rejected by ADR-0023 and still is.
- **A new email type for this action**: the per-person setup link already does
  the job.
- **Rolling the removal back when a mail fails**: one unreachable address
  would block everyone else's removal.
- **Letting any administrator do it**: not every administrator has a local
  password, and the owner restricted it to the primary administrator.
- **A greyed-out button for people who cannot act**: replaced by the quiet
  line (50a).
- **Round 2 UI (direction S)**: rejected as cluttered (owner, 2026-11-04);
  replaced by round 3.
