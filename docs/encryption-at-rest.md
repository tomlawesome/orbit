# Encryption at rest

This document states, plainly, what protects Orbit's data while it is sitting
on disk — not while it is moving over the network (see [Authentication and
Authentik setup](authentication.md) for TLS/session concerns) and not while
Orbit is running. It follows from the 2026-08-13 discussion recorded against
issue #364, after #261/#296 fixed the backup and recovery-bundle crypto in
place. There is no proprietary crypto here and no marketing framing: three
real layers exist, one of them is deliberately absent, and the trade-off that
follows from that absence is spelled out below rather than hidden.

## The three layers that exist

### 1. Document bytes: application-layer envelope encryption

Every document Orbit stores is encrypted before it reaches the filesystem,
starting with the first document ever uploaded — there is no unencrypted
period to migrate out of. `src/server/documents/crypto.ts` generates a fresh
random 256-bit data-encryption key (DEK) per document, encrypts the document
bytes with it under AES-256-GCM, and then wraps that DEK — separately, also
under AES-256-GCM — with the instance's key-encryption key (`DOCUMENT_KEK`).
Both the content ciphertext and the wrapped key are bound with authenticated
additional data (document ID, household ID, item ID, media type, and
plaintext size), so ciphertext cannot be replayed against a different
document or a different household.

The document volume (`/var/lib/orbit/documents`, UID/GID 1001 only) therefore
contains ciphertext only. PostgreSQL holds the wrapped per-document keys and
metadata, never a plaintext document key or plaintext document bytes. See
[docs/document-threat-model.md](document-threat-model.md) for the full
boundary this sits inside.

**This layer's own weak point is the key, not the algorithm.** `DOCUMENT_KEK`
(or `DOCUMENT_KEK_FILE`) is a 32-byte hex value that Orbit reads from a file
under `.orbit-secrets/` on the host, mounted into the container and copied
into a private in-memory filesystem before the process drops root (see the
threat model's "Secrets" trust boundary). That file sits on the host disk in
cleartext, next to the ciphertext it protects, with mode `0600` as its only
protection. On a host without disk encryption, anyone who can read the
filesystem gets the key and the ciphertext in the same reach — the envelope
buys nothing in that scenario. This is exactly why layer 4 (below) exists.

### 2. Database contents: none, by default — this is a real gap, not an oversight

Stock PostgreSQL has no transparent data encryption (TDE). Orbit does not add
any: the PostgreSQL data directory (the named `orbit-postgres` volume) is
**cleartext on disk**. That includes household and item names, filenames and
media types (which the threat model already treats as potentially sensitive
on their own), audit events, session data, and every other row Orbit writes.
Percona's `pg_tde` extension is a possible future option — its WAL encryption
is still marked experimental upstream, so Orbit does not depend on it today.
It is being watched, not adopted, until that changes.

Practically, the only thing standing between "database file on disk" and
"readable data" for an instance's PostgreSQL volume is host disk encryption —
layer 4. There is no application-layer substitute for this today, and
claiming otherwise would be the marketing framing this document exists to
avoid.

### 3. Backups and recovery bundles

Two different artifacts exist, and they are protected differently — worth
being precise about rather than lumping them together as "backups are
encrypted":

- **`orbit backup` / `scripts/backup.sh`** produces one tar
  (`orbit-<timestamp>.tar`) containing a manifest, checksums, a `pg_dump`
  database dump, and the document tree. Inside that tar, the **document
  archive is encrypted** with AES-256-CBC (PBKDF2-SHA256, 600,000 iterations)
  using the same `DOCUMENT_KEK` that protects live documents — so a backup is
  exactly as recoverable, and exactly as exposed, as the live document store
  is. The **database dump inside the same tar is plaintext** `pg_dump`
  output. Nothing in `backup.sh` encrypts it; a backup tar sitting on an
  unencrypted disk (or an unencrypted off-host copy) discloses the database
  in full to whoever can read the file. This is the second half of the
  database gap above, not a separate issue.
- **`orbit export-recovery-bundle` / `scripts/export-recovery-bundle.sh`**
  produces a much smaller, separate bundle whose only job is to let an
  operator recover the `DOCUMENT_KEK` itself using a memorised passphrase
  (12 characters minimum, confirmed twice) instead of the raw key file. The
  key is wrapped in the **ORBKEK01 envelope**: an scrypt-derived
  (`N=131072, r=8, p=1`) AES-256-GCM key, fresh salt and IV per export, AAD-
  bound to the format magic. This bundle does not contain documents or
  database rows — it exists purely so a lost `document-kek` secret file does
  not mean a permanently unreadable document archive. See
  `docs/adr-notes/296-backup-port-plan.md` for the implementation slice this
  landed in.
- **Repair/restore checkpoints** (`scripts/restore.sh`'s `create_checkpoint`,
  and the equivalent path in `scripts/repair.sh`) are plain, unencrypted
  files under a `0700` directory with `0600` file modes — the same posture as
  the database dump above, not the ORBKEK01 envelope. They are private,
  root-only, transient, and never leave the host by design, but they are not
  an at-rest control in their own right.

### 4. The disk: the layer that actually carries the other three

None of the above is a substitute for whole-disk or whole-volume encryption
(LUKS/dm-crypt, or the equivalent on a managed host). It is the layer that
protects the database contents in full, the plaintext half of an ordinary
backup, restore/repair checkpoints, and — critically — the `DOCUMENT_KEK`
file that the document envelope's security depends on. Orbit does not set
this up and cannot verify it from inside a container; it is entirely the
host operator's responsibility.

## The trade-off this creates

An encrypted host disk needs a passphrase (or an unlock key from something
like a TPM/Clevis setup, which Orbit does not configure) before it will
mount. That means an operator who wants disk encryption is also choosing that
**an unattended reboot — a power cut, a host restart, a scheduled kernel
update — will not bring Orbit back up on its own.** Someone has to be present
to unlock the disk, or Orbit stays down until they are.

This is a genuine trade-off, not a solved problem: "survives an unattended
reboot" and "protected at rest while powered off" pull in opposite
directions for a self-hosted single instance with no separate secrets
infrastructure. Orbit does not pick a side. The launcher advisory below
exists so the operator picks it knowingly, rather than by accident.

## What is not encrypted, summarised

| At rest | Protected by | Not protected by |
| --- | --- | --- |
| Document bytes (live volume) | Application envelope (DOCUMENT_KEK) + disk encryption | — |
| Document bytes (inside an `orbit backup` tar) | Application envelope (same DOCUMENT_KEK) + disk encryption | — |
| `DOCUMENT_KEK` secret file itself | Filesystem mode `0600`/`0400` + disk encryption | Application envelope (it *is* the key) |
| PostgreSQL data directory | Disk encryption only | No database-level or Orbit-level encryption |
| Database dump inside an `orbit backup` tar | Disk encryption only | No application-layer encryption |
| Restore/repair checkpoints | Filesystem mode `0600`/`0700` + disk encryption | Application-layer encryption |
| `DOCUMENT_KEK` inside a recovery bundle | ORBKEK01 passphrase envelope | — |

Nothing in this table is a defect to be quietly fixed later without changing
the design — the database and checkpoint rows are the deliberate, documented
scope described above, not gaps someone forgot about.

## Launcher/installer advisory

Because the disk is the layer everything else leans on, the installer should
tell an operator plainly whether the target filesystem looks encrypted, at
the point they choose where to install:

- **Detect, don't decide.** Check whether the target path's filesystem is
  backed by an encrypted block device (for example, a LUKS/dm-crypt mapping)
  and report what was found in plain words.
- **Recommend, never block.** An unencrypted disk is a legitimate choice for
  a household running a self-hosted instance on trusted hardware; the
  advisory names the trade-off from the section above and points at this
  document, and installation proceeds either way.
- **Say it once, not as an error.** This is advisory output alongside the
  installer's other configuration summary, not a warning that repeats on
  every command.

This advisory is not implemented in this repository as of this writing — the
detection and messaging belong in the installer/launcher surface, which is
where this document's guidance should be wired in next. Nothing above depends
on that landing first; the encryption layers described here are already in
effect regardless of what the installer says about the disk underneath them.

## Related documents

- [Secure document threat model](document-threat-model.md) — the full trust
  boundary the document envelope (layer 1) sits inside.
- [Administrator operations](administrator-operations.md) — the operational
  log and diagnostics surfaces that never disclose the values this document
  is about.
- `docs/adr-notes/296-backup-port-plan.md` — where the ORBKEK01 envelope and
  backup-bundle crypto were ported and characterised.
