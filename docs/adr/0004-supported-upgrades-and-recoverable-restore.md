# ADR-0004: Supported upgrades and recoverable restore

**Status:** Accepted
**Date:** 2026-07-27

## Context

Orbit has versioned PostgreSQL migrations and authenticated database/document
backup bundles. Existing evidence proves that an empty database starts and that
one database marker plus one opaque document object round-trips. It does not
define the oldest supported installed revision, prove migration compatibility,
validate database-to-object correspondence, or make a hard-interrupted restore
operationally recoverable.

PostgreSQL and the encrypted document volume cannot be switched in one atomic
transaction. Orbit therefore needs a bounded recovery protocol rather than an
unverifiable claim of cross-resource atomicity.

## Decision

### Upgrade floor and migration contract

- The oldest supported pre-v1 installation is the engineering preview at
  commit `8a8e37e2bbef770de9a203e86a674f70834e2a18`, historically tagged
  `rc-2026.07.27.96`. Its migration journal ends at
  `0017_imap_recipient_alias_index`.
- A checked-in, synthetic fixture records that provenance, the PostgreSQL 17
  requirement, the migration-prefix checksums and representative fake data. It
  is not generated from a live database and contains no real identities,
  sessions, documents or provider data.
- Migrations at or below the supported floor are immutable. New schema changes
  append migrations. A reviewed, independent catalogue contract verifies enum
  labels, columns, primary/unique/foreign-key constraints, delete behaviour and
  required indexes after both fresh and upgraded paths.
- The current baseline-to-head upgrade is intentionally a no-op because the
  baseline already contains migrations `0000` through `0017`. The fixture still
  protects data and makes the next appended migration exercise a real upgrade
  without changing the supported floor.
- Re-running the migrator must be idempotent. A failed migration must return an
  actionable bounded error and must not record the failed entry as applied.

Orbit does not support automatic database downgrade. A previous image may be
restarted against an upgraded database only when that exact compatibility has
been reviewed and tested. Otherwise rollback means restoring the pre-update
backup with the matching previous image. Update procedures therefore create
and retain a verified recovery point before applying migrations.

### Restore contract

Restore is a recoverable staged cutover:

1. While the active application remains available, authenticate the manifest,
   verify checksums and paths, validate the PostgreSQL archive, prove the
   configured KEK can decrypt the document archive, and stage the database and
   document tree in disposable private locations.
2. Validate staged database/document correspondence before touching active
   state. Every `document_crypto` row has exactly one correctly named object
   whose byte length equals `ciphertext_size`; every stored object is referenced;
   and every `available` or `pending_deletion` document has crypto metadata.
   Inconsistent transient lifecycle state fails with a bounded operator action
   rather than being guessed during cutover.
3. Check that working and rollback space is available. After explicit
   confirmation, create and verify a durable pre-restore checkpoint in the
   private backup location and record a durable restore journal. Neither may
   depend on an ephemeral temporary directory.
4. Stop the application, replace the document tree, and invoke
   `pg_restore --single-transaction --exit-on-error` for PostgreSQL. A staged
   archive that cannot be restored under that contract is rejected rather than
   weakened to sequential partial application. Recheck active correspondence
   before starting the application, then require application health before
   declaring success.
5. An ordinary failure automatically restores the checkpoint. A hard
   interruption leaves the application stopped and preserves the journal and
   checkpoint. A subsequent restore invocation refuses to overwrite that
   evidence and requires an explicit resume or recover action. Recovery restores
   the prior database, document tree and KEK state before the application is
   restarted.

If automatic checkpoint restoration itself fails, Orbit remains stopped,
retains the checkpoint and journal, and returns bounded manual recovery
instructions. It never restarts into state whose database/document
correspondence has not been proven.

Wrong or missing KEK/recovery material fails before active replacement.
Recovery never generates, substitutes or overwrites a KEK implicitly. A
recovery-bundle import may install only an authenticated, explicitly supplied
key and must restore the previous key if its inner restore does not complete.

Diagnostics identify the failed stage and bounded corrective action without
printing keys, passphrases, document names or content, storage keys, session
material, provider data or raw cryptographic errors.

## Consequences

- Fresh install and supported upgrade evidence have a stable, versioned
  boundary without retaining production data or depending on Git history in
  CI.
- Application rollback remains simple when no incompatible migration was
  applied; incompatible rollback is slower because it requires the matching
  recovery point.
- Restore needs additional temporary database, document and checkpoint
  capacity. Operators must check free space and retain off-host backups plus
  separately protected recovery material.
- Cross-resource restore is not described as atomic. Its stronger guarantee is
  that active state is not touched before full preflight, ordinary failure
  rolls back automatically, and hard interruption leaves a durable,
  operator-recoverable prior state.
- Engineering previews can exercise this contract. Feature-complete release
  acceptance still requires a representative update and restore drill using
  the exact candidate digest.

## Alternatives considered

- **Support every pre-v1 revision:** rejected because pre-release schemas did
  not carry a durable compatibility promise.
- **Derive expected schema from the current ORM declarations:** rejected
  because it would make schema verification tautological.
- **Allow automatic database downgrade:** rejected because destructive or
  incompatible reverse migrations are not proven.
- **Rely only on shell cleanup traps:** rejected because process termination or
  host failure can bypass them and discard ephemeral rollback state.
- **Claim an atomic database/filesystem switch:** rejected because the
  supported PostgreSQL and local-volume topology has no shared transaction.
- **Generate a replacement KEK during recovery:** rejected because it could
  make surviving ciphertext permanently unreadable.
