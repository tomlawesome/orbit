-- ADR-0024's contract step (#1403 Q3, owner 2026-10-13): the plaintext copies
-- of the encrypted metadata go. The application has read only the `*_enc`
-- columns and the blind indexes since parts A to C, so nothing reads these.
-- The uniqueness rules ("one account per address", "one sender per address",
-- "one open invitation per address") already stand on the blind-index
-- indexes `user_email_unique_index`, `mail_in_sender_address_unique_index`
-- and `household_invitation_open_once_index`, which stay.
-- Dropping a column also drops the indexes over it; they are dropped by name
-- first so the migration reads as what it removes.
DROP INDEX "user_email_lookup_idx";--> statement-breakpoint
DROP INDEX "user_email_unique_ci";--> statement-breakpoint
DROP INDEX "household_invitation_open_once";--> statement-breakpoint
DROP INDEX "mail_in_sender_address_unique";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "notes";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "reference";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "items" DROP COLUMN "cost_minor";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "household_invitations" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "mail_in_sender_addresses" DROP COLUMN "address";--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" DROP COLUMN "proposal";--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" DROP COLUMN "field_evidence";
