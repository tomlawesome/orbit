-- Account addresses behind the KEK, expand phase (ADR-0024, #969 / slice 2 of #966).
--
-- `users.email` and `mail_in_sender_addresses.address`: the two remaining
-- readable copies of a person's address. Both sit under the INSTANCE metadata
-- key, not a household one — a user belongs to several households, and a
-- sender is attributed before any household is known — so no new key, no new
-- table and no new cipher construction appear here. The `mdv1.` envelope and
-- the rewrap path are the ones Tier 1 and Tier 2 already use.
--
-- Expand only, exactly as 0040 and 0041: every column added is nullable, every
-- existing column and index stands, and no value is rewritten. The running
-- release reads `*_enc` when it is non-null and the plaintext column
-- otherwise, so every row is readable throughout, and the resumable backfill
-- (`src/server/metadata/backfill.ts`) converts the remainder after start-up.
-- Dropping the plaintext columns is the contract release's migration.
--
-- Nothing here can encrypt: the KEK is an application secret and is not
-- available to SQL.

-- Both addresses were NOT NULL. An encrypted row clears its plaintext, so the
-- constraint has to go before the backfill can run. What now insists an
-- account has an address is the application, plus the blind unique index
-- below.
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_index" text;--> statement-breakpoint
-- "One account per address" is enforced by the database today
-- (`user_email_unique_ci`, over `lower(email)`). Clearing the plaintext would
-- quietly retire that rule, because PostgreSQL treats every NULL as distinct,
-- so this index carries it across. Both stand through the expand release: the
-- case-insensitive one still constrains the rows the backfill has not reached.
CREATE UNIQUE INDEX "user_email_unique_index" ON "users" USING btree ("email_index");--> statement-breakpoint
ALTER TABLE "mail_in_sender_addresses" ALTER COLUMN "address" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_in_sender_addresses" ADD COLUMN "address_enc" text;--> statement-breakpoint
ALTER TABLE "mail_in_sender_addresses" ADD COLUMN "address_index" text;--> statement-breakpoint
-- The same carry-across for `mail_in_sender_address_unique`, and the index
-- exact-match attribution actually reads: the mail-in worker looks a sender up
-- by this value, never by scanning.
CREATE UNIQUE INDEX "mail_in_sender_address_unique_index" ON "mail_in_sender_addresses" USING btree ("address_index");
