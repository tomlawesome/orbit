import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { ATTACHMENT_CONTENT_HASH_COLUMN, openContentHash, sealContentHash } from "@/server/documents/content-hash";
import { setPdfStructureSandboxLimitsForTests } from "@/server/documents/pdf-structure-sandbox";
import { ONE_PAGE_PDFINFO, writeStubTool } from "../../support/poppler-sandbox";
import { openMetadataReader, openReceiptMetadataWriter, requireInstanceMetadataWriter } from "@/server/metadata/fields";

/* Seeding and reading for the #1778 tests (mail-in attachment hashes sealed
   under the receipt's scope key). Raw SQL on purpose: the message-level
   `content_sha256` column is dropped by this change and the attachment table
   gains `content_sha256_sealed` and `content_index`, so rows are written by
   column name, and a test fails where the schema is not yet right.

   Names taken from design note 58551 (build notes B and C):
   `sealContentHash(cipher, rowId, hex, ATTACHMENT_CONTENT_HASH_COLUMN)`,
   `openContentHash(cipher, rowId, { plain, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN)`,
   `MetadataCipher.attachmentContentIndex(messageId, hex)`. */

export const sha256Of = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Where a seeded seal is made: the instance key (an unattributed receipt) or a household's. */
export type SealScope = { household: string } | "instance";

const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

/** Until the expand migration drops `imap_ingestion_messages.content_sha256` it is NOT NULL, so a seed must fill it; afterwards it must not. */
async function messageHashColumn() {
  const rows = await getDb().execute(sql`select 1 from information_schema.columns where table_name = 'imap_ingestion_messages' and column_name = 'content_sha256'`);
  return rows.length > 0;
}

export async function seedReceipt(input: {
  userId: string;
  householdId: string | null;
  status?: "pending_review" | "processing";
  uid?: number;
  mailbox?: string;
  uidValidity?: string;
  leaseToken?: string | null;
  lockedAt?: Date | null;
  attempts?: number;
}): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? "pending_review";
  const legacyHash = await messageHashColumn();
  await getDb().execute(sql`
    insert into imap_ingestion_messages
      (id, ${legacyHash ? sql`content_sha256, ` : sql``}mailbox, mailbox_uid_validity, mailbox_uid, recipient_alias_sha256, user_id, household_id, status, receipt_status,
       expires_at, attachment_processing_lease_token, attachment_processing_locked_at, attachment_processing_attempts)
    values
      (${id}, ${legacyHash ? sql`${id}, ` : sql``}${input.mailbox ?? "private"}, ${input.uidValidity ?? `hash-${id}`}, ${input.uid ?? 501}, ${`alias-${id}`}, ${input.userId},
       ${input.householdId}, ${status}, ${status === "processing" ? "processing" : "pending"},
       ${FUTURE()}::timestamptz, ${input.leaseToken ?? null}, ${iso(input.lockedAt)}::timestamptz, ${input.attempts ?? 0})`);
  return id;
}

export async function sealFor(scope: SealScope, attachmentId: string, hex: string): Promise<string> {
  const cipher = await openReceiptMetadataWriter(scope === "instance" ? null : scope.household);
  return sealContentHash(cipher, attachmentId, hex, ATTACHMENT_CONTENT_HASH_COLUMN);
}

export async function indexFor(messageId: string, hex: string): Promise<string> {
  const index = (await requireInstanceMetadataWriter()).attachmentContentIndex(messageId, hex);
  if (!index) throw new Error("no attachment index");
  return index;
}

export interface SeedAttachmentOptions {
  id?: string;
  /** The file's SHA-256 (hex). */
  sha256: string;
  displayName?: string;
  /** Write a plain `content_sha256` (a row from before this release, or the "plain fallback" case). */
  plain?: boolean;
  /** Write `content_sha256_sealed` under this scope; omit for none. */
  sealedUnder?: SealScope;
  /** Write the blind index; defaults to true when sealed, false otherwise. */
  index?: boolean;
  status?: "stored" | "assigned" | "rejected";
  createdAt?: Date;
}

export async function seedAttachment(messageId: string, options: SeedAttachmentOptions): Promise<string> {
  const id = options.id ?? randomUUID();
  const sealed = options.sealedUnder ? await sealFor(options.sealedUnder, id, options.sha256) : null;
  const contentIndex = (options.index ?? options.sealedUnder !== undefined) ? await indexFor(messageId, options.sha256) : null;
  /* A legacy-shaped row (plain only) is written without the new columns, so it can be seeded on a database that does not have them yet. */
  const withNew = sealed !== null || contentIndex !== null;
  await getDb().execute(sql`
    insert into imap_ingestion_attachments
      (id, message_id, display_name, media_type, size_bytes, content_sha256, ${withNew ? sql`content_sha256_sealed, content_index, ` : sql``}storage_key,
       ciphertext_size, envelope_version, content_iv, content_auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, status, created_at)
    values
      (${id}, ${messageId}, ${options.displayName ?? `held-${id}.pdf`}, 'application/pdf', 10,
       ${options.plain ? options.sha256 : null}, ${withNew ? sql`${sealed}, ${contentIndex}, ` : sql``}${`review/${randomUUID()}`},
       20, 1, 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key', ${options.status ?? "stored"}, ${(options.createdAt ?? new Date()).toISOString()}::timestamptz)`);
  return id;
}

export type AttachmentColumns = {
  id: string;
  messageId: string;
  plain: string | null;
  sealed: string | null;
  contentIndex: string | null;
  storageKey: string;
};

export async function attachmentColumns(id: string): Promise<AttachmentColumns> {
  const rows = await getDb().execute<AttachmentColumns>(sql`
    select id, message_id as "messageId", content_sha256 as plain, content_sha256_sealed as sealed, content_index as "contentIndex",
           storage_key as "storageKey"
      from imap_ingestion_attachments where id = ${id}`);
  if (!rows[0]) throw new Error(`attachment ${id} does not exist`);
  return rows[0];
}

export async function attachmentsOfMessage(messageId: string): Promise<AttachmentColumns[]> {
  return [...await getDb().execute<AttachmentColumns>(sql`
    select id, message_id as "messageId", content_sha256 as plain, content_sha256_sealed as sealed, content_index as "contentIndex",
           storage_key as "storageKey"
      from imap_ingestion_attachments where message_id = ${messageId} order by created_at, id`)];
}

/** Opens a stored seal with the reader of one scope; `null` is the instance key. */
export async function openSeal(scope: SealScope, attachmentId: string, sealed: string | null) {
  const reader = await openMetadataReader(scope === "instance" ? null : scope.household);
  return openContentHash(reader, attachmentId, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN);
}

/** The household of a message row, read raw. */
export async function householdOfMessage(messageId: string): Promise<string | null> {
  const rows = await getDb().execute<{ householdId: string | null }>(sql`select household_id as "householdId" from imap_ingestion_messages where id = ${messageId}`);
  return rows[0]?.householdId ?? null;
}

/* The structure check of a PDF shells out to poppler, which a development host
   may not have and which these tests are not about: a stand-in `pdfinfo`
   answers one page. `stubPdfinfo()` installs it and returns the undo. */
export function stubPdfinfo(): () => void {
  const directory = mkdtempSync(join(tmpdir(), "orbit-attachment-hash-"));
  const path = writeStubTool(directory, "pdfinfo", `/usr/bin/printf '${ONE_PAGE_PDFINFO.replaceAll("\n", "\\n")}'`);
  setPdfStructureSandboxLimitsForTests({ pdfinfoPath: path } as never);
  return () => {
    setPdfStructureSandboxLimitsForTests(undefined);
    rmSync(directory, { recursive: true, force: true });
  };
}
