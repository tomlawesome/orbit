# ADR-0044: An item has no type; its schedule follows from its date and its repeat

**Status:** Accepted (owner decisions 40 and 41, 2026-11-01; #1466, #1468)
**Date:** 2026-11-05
**Amends:** ADR-0034 decision 2 (`item.upsert` no longer carries a kind)

## Context

ADR-0034 made the engine map a member-chosen kind (service, renewal, inspection, suggestion, document) to a schedule kind and a subtype. Alpha testers could not tell the kinds apart (#1466), and the owner ruled that types are gone: the item asks how it repeats, and sections are the categories. Items never had a type column; the kind was read back from `items.subtype` and the open event's kind.

## Decision

1. A command carries the item's date and how it repeats; nothing names a type. The engine gives a new item with a date the `renewal` schedule kind, and a dateless item no schedule. An edit keeps the stored schedule kind.
2. The schedule kind (`renewal`, `service`, `expiry`) stays as the engine's record of where a date came from: a member's date, a service date or an expiry read from a document by mail intake. Only `expiry` changes behaviour (it ends and never comes round); the other two differ in the column and the activity name alone.
3. `items.subtype` returns to being the free-text descriptor a document proposal gives. The five marker words already stored are left in place; a later release nulls them once nothing has read them for a release.
4. Compatibility by accept-and-ignore: `item.upsert` tolerates `kind` for one release and ignores it; the read payload's derived `kind` goes now, because the web ships with the engine. The `item_kind_missing` refusal is retired.

## Consequences

No migration in v0.3.7; one data clean-up later. Add, the drawer's quick add, the edit drawer, the chart key and the tour lose their type controls. Grouping and colour are the section's (decision 41). Anything that must distinguish an expiry reads `scheduleKind`, never a type.
