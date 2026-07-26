# Orbit administrator operations

This document defines the security and state-transition contract for
`ORB-FUT-004`. The operations interface is diagnostic and corrective; it is not
a generic database editor or log viewer.

## Information boundary

Only authenticated instance administrators may use operations APIs. Every
response is non-cacheable. Responses may contain:

- worker state and last successful cycle time;
- configured/unconfigured provider state;
- counts by bounded status and safe failure category;
- job identifiers, kind, attempts, lifecycle state, and timestamps;
- actor/household/action labels from the audit history.

Responses must never contain credentials, provider URLs, recipient addresses,
push endpoints or keys, raw exception text, raw audit `changes`, document
names/content/hashes/storage keys, request headers, sessions, or message bodies.

Worker boundaries convert errors to versioned categories before persistence:

- notifications: `smtp_unconfigured`, `smtp_unavailable`, `smtp_rejected`,
  `push_unconfigured`, `push_unsubscribed`, `push_unavailable`,
  `recipient_preferences_disabled`, or `unknown`;
- documents: existing controlled codes such as `key_unavailable` and
  `purge_failed`.

Historical raw notification errors remain internal and are never returned.

## Corrective actions

All mutations require CSRF validation, administrator authorization, an exact
expected source state, and an audit event.

- A failed or cancelled notification may be retried. Its attempt count, lock,
  sent time, and failure state are cleared and it is scheduled immediately.
- A pending, retrying, or failed notification may be discarded as cancelled.
- A failed document job may be retried from attempt zero.
- A failed document job may be discarded as cancelled. This never deletes or
  restores document bytes; a pending-deletion document remains visible as
  retention cleanup paused.
- Processing work is never mutated by an administrator. The API returns the
  same non-enumerating conflict response for missing and non-actionable IDs.

Notification delivery remains at-least-once: SMTP cannot guarantee that a
provider accepted a message but the subsequent database update succeeded.
Retry actions must state this duplicate-delivery risk.

Document worker completions use an unguessable lease token. A stale worker may
not overwrite a job claimed by a newer worker.

## Provider tests

The SMTP test verifies connection and authentication only. It does not send a
message and returns a bounded result category. It has a short timeout and never
returns configuration or provider response text. Push tests, when added, target
only the requesting administrator's current subscription and cannot select an
arbitrary recipient.

## Audit history

Instance-wide actions may have no household, so `audit_log.household_id` is
nullable. Administrator history is cursor-paginated and selects only safe
columns. Raw `changes` remain available solely to trusted internal code.
Unknown future action codes receive a generic label rather than exposing raw
payloads.
