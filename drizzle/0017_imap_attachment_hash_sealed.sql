-- #1778 expand (design note 58551): mail-in attachment hashes move to a
-- sealed value and a blind index; the backfill fills them, a later release
-- drops the plain column (#1835). Edited by hand: 0000_baseline made
-- imap_attachment_message_hash_unique a UNIQUE constraint, not the bare index
-- the snapshot records, so it is dropped as a constraint.
ALTER TABLE "imap_ingestion_attachments" DROP CONSTRAINT "imap_attachment_message_hash_unique";--> statement-breakpoint
DROP INDEX "imap_message_recipient_content_idx";--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ALTER COLUMN "content_sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "content_sha256_sealed" text;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "content_index" text;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" DROP COLUMN "content_sha256";--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD CONSTRAINT "imap_attachment_message_index_unique" UNIQUE("message_id","content_index");