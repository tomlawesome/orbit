# ADR-0024: Tier 1 metadata encrypts under one per-household DEK beneath the existing KEK, with a derived per-household blind index

**Status:** Proposed (for owner ratification; drafted 2026-09-09 under the
owner's tiering decision of 2026-08-13 on #365, "Tiered application-layer
encryption for household metadata")
**Date:** 2026-09-09
**Relates to:** #365 (the epic; tiers and threat model are decided there and
not reopened here); #928 (this design slice); ADR-0017 (the rewrap contract
this ADR joins, and the precedent for sharing the document KEK); ADR-0010
(the resumable-job pattern the backfill follows); ADR-0004 (restore is the
rollback path across the migration); `docs/document-threat-model.md` (the
boundary being extended)

## Context

The owner decided on #365 what is encrypted and against whom: Tier 1 —
`items.notes` (`src/db/schema.ts:417`), `items.reference` (:408),
`imap_ingestion_messages.proposal` (:644) and `.field_evidence` (:645) —
ships first; the boundary is database-file leakage, not live host
compromise. What was left open, and what this ADR settles, is the
cryptographic shape: key hierarchy, blind index, storage and migration,
rotation, and failure behaviour.

Facts verified in the tree on 2026-09-09:

- The scheme to extend is `src/server/documents/crypto.ts`: AES-256-GCM
  envelopes with generic, AAD-parameterised primitives (`wrapKeyWithAad`
  :91, `unwrapKeyWithAad` :106, `encryptWithAad` :127) that ADR-0017
  established as the only construction — new purposes add AAD builders,
  never ciphers. The KEK arrives as `DOCUMENT_KEK`/`DOCUMENT_KEK_FILE`
  via `readRuntimeSecret` (`src/lib/runtime-secret.ts`), and its `keyId`
  is derived at `src/server/documents/config.ts:85`.
- `rewrapDocumentKey` (`crypto.ts:226`) and the `"rewrap"` value in
  `document_job_kind` (`schema.ts:29`) exist with no worker. ADR-0017
  records that gap and the contract any future rewrap command must meet:
  every `mail_in_secrets` row, selected by `key_id`, in the same
  transaction as `document_crypto`. This ADR inherits that contract.
- Nothing filters or sorts on the Tier 1 columns in SQL. Every comparison
  is application-side over selected values: `document-drafts.ts:58` and
  `portable-archive-repository.ts:236, 258` use plain `toLowerCase()`
  equality; `mail-in/core/review-state.ts:96-100` (`comparableText`) uses
  NFKC, control-character replacement, whitespace collapse, trim and
  locale-aware lowercasing.
- Document decryption failure is fail-closed and content-free:
  `document_integrity_failed`, 503, no plaintext and no fabrication
  (`src/server/document-repository.ts:756-765`). A missing KEK locks
  document operations but leaves the application usable
  (`docs/document-threat-model.md:270-276`).
- `imap_ingestion_messages.household_id` is nullable (`set null`,
  `schema.ts:640`): a receipt can exist before attribution and lose its
  household later, so its owning household is not a stable fact of the row.

## Decision

### 1. Key hierarchy: one metadata DEK per household, under the existing KEK

A new table `metadata_keys` holds one wrapped 32-byte random DEK per scope:
`scope` (`household` | `instance`), `household_id` (uuid, nullable, unique,
cascade delete; non-null exactly when scope is `household`), the envelope
columns exactly as `document_crypto` (`schema.ts:454-466`): `envelope_version`,
`wrapped_dek`, `wrap_iv`, `wrap_auth_tag`, `key_id`; plus `version` and audit
columns. The DEK is wrapped with `wrapKeyWithAad` under the existing KEK with
key-wrap AAD `{purpose: "orbit-metadata-dek", envelopeVersion, scope,
householdId, keyId}` (`householdId: null` for the instance row). Every Tier 1
value in a household encrypts under that household's DEK; the single
`instance` row exists only for `imap_ingestion_messages` rows that have no
household yet. When attribution sets `household_id`, the same transaction
re-encrypts `proposal` and `field_evidence` under the household's DEK; when
`set null` fires, the values are already gone with the receipt content or are
re-encrypted under the instance DEK by the same statement that nulls the
column.

**Per household, not per row or per column family.** The household is Orbit's
ownership and isolation boundary — every Tier 1 row carries `household_id`
and dies with it. Tier 2's plan (decrypt-and-scan at household scale) reads
many rows per request; one DEK unwrap per request, not per row, keeps that
linear in AES operations only. Rotation stays O(households), and dropping a
household's key row on cascade crypto-shreds any stray copy of its
ciphertext. Per-document DEKs were right for documents because each object
is large, individually fetched and individually purged; none of that is true
of metadata fields.

**The existing KEK, not a second one.** Same reasoning ADR-0017 recorded for
mail-in secrets: a second key buys no isolation — both would sit on the same
host inside the same boundary — and doubles the key-loss and recovery-bundle
story. It would also create the operator who rotates one KEK and not the
other, leaving half the data on a key whose bundle they may have discarded;
with one KEK that operator cannot exist. The environment name stays
`DOCUMENT_KEK`: it is historical, and documentation now describes it as the
instance key-encryption key. An in-process cache of unwrapped household DEKs
is permitted — the KEK itself already lives in process memory, so the cache
adds nothing to what a live compromise yields.

### 2. Blind index: per-household HMAC key derived from the DEK

`items.reference` gets a sibling column `reference_index`: base64url of
HMAC-SHA-256 over the normalised value, keyed by a per-household index key
derived from the household DEK with HKDF-SHA-256 (`node:crypto` `hkdfSync`,
info `"orbit-blind-index-v1:items.reference"`). The key is never stored:
holding the DEK yields it, losing the DEK loses it, and a KEK rewrap — which
leaves DEKs unchanged — leaves every index valid untouched. A composite
index on (`household_id`, `reference_index`) serves the lookup; writes set
ciphertext and index in the same statement, so they cannot drift except by
bug.

**Normalisation** is the existing `comparableText` (`review-state.ts:96-100`),
promoted to the one shared canonical form: NFKC, control characters to
spaces, whitespace collapsed, trimmed, lowercased. Punctuation is kept,
deliberately: stripping it would merge references that differ today
("AB-123" vs "AB123"), a product-behaviour change this ADR has no mandate
for. Readers that today compare plaintext with plain `toLowerCase()` keep
doing exactly that on decrypted values at household scale; the index exists
for lookups that would otherwise decrypt every row, not to replace in-app
comparison.

**What it leaks.** Within one household, an attacker holding only the
database file learns which rows share an equal normalised reference and how
many distinct references exist — equality and cardinality at household scale
(tens to low hundreds of rows), nothing about values, prefixes or order.
Because the key is per-household, equal references in different households
produce unrelated digests: no cross-household or cross-instance correlation,
and no dictionary attack without the DEK. That residual leak is accepted;
it is the stated price of exact-match lookup in #365.

### 3. Storage shape: sibling columns, expand/backfill/contract

Each encrypted value is one text column beside the plaintext one it
replaces: `items.notes_enc`, `items.reference_enc`,
`imap_ingestion_messages.proposal_enc`, `field_evidence_enc`, plus
`items.reference_index`. A value is a compact versioned envelope string,
`mdv1.<iv>.<authTag>.<ciphertext>` (base64url segments), produced by
`encryptWithAad` under the scope DEK with content AAD `{purpose:
"orbit-metadata-value", envelopeVersion, table, column, rowId}` — so
ciphertext cannot be replayed into another row or column without failing
authentication. JSONB values are serialised then encrypted whole; `notes`
and `reference` are independent envelopes so updating one never rewrites
the other. Household id is deliberately absent from the AAD (it is nullable
and mutable on receipts); household binding comes from which DEK encrypted
the value.

**Migration, with every row readable throughout.** Release N adds the
nullable columns and `metadata_keys`; application code reads `_enc` when
non-null, else the plaintext column, and writes encrypted-only, clearing
the plaintext (`NULL`, or `{}` for the NOT NULL JSONB columns) in the same
statement. A resumable startup job in the ADR-0010 mould backfills the
remainder in small per-transaction batches: create the scope key if
missing, encrypt, set `_enc` and index, clear plaintext. Every row is at
all times in exactly one of two states the running release reads, and a
crash mid-batch loses nothing. Release N+1's migration first verifies zero
plaintext remains — failing loudly rather than dropping data — then drops
the plaintext columns and their defaults. Rolling back release N after
partial backfill is roll-forward-or-restore (ADR-0004): the data is intact
but N−1 cannot read encrypted rows, and that is accepted rather than
carrying a decrypt-back path nobody would trust.

### 4. Rotation: one more table in ADR-0017's transaction, online

The future rewrap command ADR-0017 specifies gains one clause: it rewraps
every `metadata_keys` row (selected by `key_id`, via `rewrapDocumentKey`'s
generalised form) in the same transaction as `document_crypto` and
`mail_in_secrets`. Because values encrypt under DEKs and only the wrapping
changes, KEK rotation touches one row per household plus one instance row —
no value rewritten, no index rebuilt, no maintenance window; the
transaction is O(households + documents + secrets), all of it row updates.
Replacing a household's DEK itself (suspected DEK compromise, not KEK) is
the expensive path: re-encrypt that household's values and recompute its
indexes in one bounded transaction. That is a per-household operation at
household scale, still online for everyone else, and it is expected to be
rare enough that no dedicated tooling ships until something needs it.

### 5. Failure behaviour: refuse the value, keep the row, allow the repair

Consistent with documents (`document_integrity_failed`,
`document-repository.ts:764`): fail-closed and content-free, but scoped to
the field, because one damaged note must not take down a household's item
list. A value that fails authentication is surfaced as damaged — a distinct
marker in the API response (`metadata_integrity_failed`), never an empty
string, never fabricated plaintext — while the row's structural Tier 3
fields render normally. Each failure logs an administrator diagnostic with
row and column, non-sensitive, matching the distinct-diagnostics rule in
`docs/document-threat-model.md:272-273`. A damaged `reference` simply never
matches a blind-index lookup. Writing to a damaged field is allowed and is
the repair: the new value encrypts cleanly. A missing KEK is the separate,
already-defined state: the application stays usable, Tier 1 fields show as
locked — not damaged — and writes to them are refused, exactly as document
operations lock today.

### 6. What the documentation says

`docs/document-threat-model.md` gains a metadata section stating the
boundary in the epic's own words: this protects against database-file
leakage — exfiltrated volumes, SQL dumps, filesystem backups — and does
**not** protect against live compromise of the host, because the KEK lives
there; it is the same boundary as document encryption, no stronger, and no
Orbit surface may describe it as more. Backup and setup documentation is
amended in the implementing slice: ordinary database dumps no longer
contain readable notes, references or mail-in extracts (true only once the
contract phase lands); restore requires the same KEK; and the existing
loss sentence extends to "encrypted documents **and Tier 1 metadata** are
unrecoverable by design" if both the KEK and the recovery bundle are lost.
The portable archive remains the plaintext escape hatch — it exports
decrypted values and therefore itself requires a working KEK.

Nothing in the six questions is left open for the owner; ratification of
this record is the remaining decision.

## Consequences

- Slices 2 and 3 of #365 can be filed: slice 2 implements sections 1–3 and
  5–6 for the four columns; slice 3 builds the rewrap worker meeting the
  extended ADR-0017 contract in section 4.
- Tier 2 inherits the hierarchy for free: same household DEK, same envelope
  string, same normaliser if any Tier 2 column ever needs an index.
- Every reader and writer of the four columns moves behind repository
  accessors; the implementing slice inventories them
  (`imap-inbox.ts`, `portable-archive-repository.ts`, `document-drafts.ts`,
  `review-state.ts`, `reviewed-intake.ts`, `workspace-repository.ts` at
  minimum) under the #298 characterise-then-change discipline.
- Item reads decrypt in the application: one DEK unwrap per request plus
  one AES-GCM operation per value, negligible at household scale.
- Tier 1 metadata joins the KEK's loss story. That is the point, and the
  documentation says it plainly.
- Two releases are needed before dumps stop leaking Tier 1 plaintext: the
  expand release still carries the plaintext columns until the contract
  release drops them.

## Alternatives rejected

- **Per-row DEKs (the document pattern):** five envelope columns on every
  table, a rewrap surface of O(rows), and per-row unwraps in bulk reads —
  bought nothing, since rows in one household share one fate anyway.
- **Per-column-family DEKs:** no ownership boundary, no crypto-shred
  alignment, and cross-household rows under one key.
- **A second, metadata-only KEK:** rejected for ADR-0017's reasons — no
  isolation gained inside one boundary, and it creates the
  rotated-one-not-the-other operator this ADR is asked about.
- **Renaming `DOCUMENT_KEK`:** operator churn and a dual-name window in
  `readRuntimeSecret`'s conflict handling for a cosmetic gain.
- **pgcrypto or transparent database encryption:** puts key material or
  plaintext in the database host's memory, configuration and statement
  logs — the exact artefacts the boundary says leak.
- **Deterministic encryption (e.g. AES-SIV) as its own index:** freezes
  equality into the ciphertext and adds a second cipher construction,
  which ADR-0017's one-construction rule forbids.
- **An instance-wide blind-index key:** leaks equality across households.
- **Stripping punctuation/whitespace beyond `comparableText`:** changes
  which references count as equal — a product decision, not a crypto one.
- **In-place column type change:** no dual-read window, so the migration
  would have exactly the unreadable-and-unrecoverable moment #928 forbids.
- **A ciphertext side table:** a join on every item read, and a row whose
  crypto can drift from it; `document_crypto` needed one because document
  ciphertext lives on disk — these values are small and belong in the row.
