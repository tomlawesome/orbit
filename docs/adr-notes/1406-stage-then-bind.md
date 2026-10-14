# #1406: an item and its file save together or not at all

Status: design ratified (owner, 2026-10-13: #1316 notes 35534, 35535 and
35556; decisions 5a, 6a, 7a). A working note under
[ADR-0033](../adr/0033-document-safety-standard-patterns.md) and
[ADR-0034](../adr/0034-engine-owns-every-rule.md). It records the design that
was, until now, only in the issue.

## The rule

Creating an item with a file saves both together or neither. Mail approval is
out of scope (#1398, v0.4).

The standard pattern is **direct upload, then attach by reference**, here
called stage-then-bind:

1. **Stage.** The file is uploaded and scanned first, unattached. It becomes
   an `available` document that belongs to no item yet.
2. **Bind.** The item and the file's link to it are then saved in one
   transaction: `item.upsert` takes `documentIds` (at most 5) and binds those
   documents to the item. If anything fails, no item is written.

The form keeps everything the member typed in every failure case, and every
failure gives an accurate reason.

## Sealing: `sealed_item_id`

Documents are sealed with their item id as AEAD context
(`src/server/documents/crypto.ts`). A file is staged before its item exists, so
it is sealed under the draft item id the form will use. That id is recorded in
`documents.sealed_item_id` (column added by migration `0052`: additive,
nullable, no foreign key or index). Reads use
`coalesce(sealed_item_id, item_id)`, so rows from before the column still open
under `item_id`.

A staged row sealed under draft id A and bound to item B could never be opened.
The bind check therefore refuses it: the check requires
`coalesce(sealed_item_id, item_id)` to equal the item id being saved. A test
stages under draft A, binds to item B, and fails when the check is removed.

## The stage route

A new household-scoped documents route. Its access check is household
membership plus `canAccessHouseholdDocuments`; it does not require the item to
exist. The document id and item id (as `x-orbit-item-id`) are required headers.
A retry under the same document id returns what the server already holds, and
bind accepts a document whose `item_id` is already this item.

## The bind check

Inside the `item.upsert` transaction, with the document rows locked
(`for update`), and **before the dry-run return**, so a dry run and a real run
cannot disagree about a refusal (ADR-0034). Unknown, foreign-household,
rejected, deleted, `pending_deletion` and sealed-id-mismatch documents all
produce one identical 422 and no item is written. A scanner outage (202) binds
as designed; the later scan result applies.

## The 24-hour hold and the orphan sweep

A staged file whose item is never saved is an orphan. Staging sets
`delete_after` to now plus 24 hours on the unbound `available` row. The
storage sweep `retireUnboundUploads` moves such a row, once expired, to
`pending_deletion`; the purge job then removes it. Without the sweep nothing
would purge it, because the purge claims only `pending_deletion` rows. The
sweep takes only `available`, unbound, expired rows, and a sweep racing a bind
is serialised by the bind's row lock.

An unbound document counts against the household's document quota for as long
as it is held. See the threat model's "Storage and state integrity" section.

## What counts as a refused file

Owner ruling, 2026-10-13: "the server refused the file" means HTTP **413, 415
or 422** (size, type, structure, malware). A refused file stays in the form,
marked with the server's reason, and Add is held until it is replaced or
removed. Any other failure shows "not saved" and leaves Add usable, so the
member can try again.
