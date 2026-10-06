-- Tier 2 metadata encryption, expand phase (ADR-0024, #963 / slice 4 of #365).
--
-- Tier 2 is `items.title`, `items.provider` (a provider NAME, which is why it
-- is Tier 2 and not Tier 1), the cost, and member email addresses. It reuses
-- everything Tier 1 built: the same per-household DEK in `metadata_keys`, the
-- same `mdv1.` envelope, the same rewrap path. No new key, no new table and no
-- new cipher construction appear here.
--
-- Expand only, exactly as 0040: every column added is nullable, every existing
-- column stands, and no value is rewritten. The running release reads `*_enc`
-- when it is non-null and the plaintext column otherwise, so every row is
-- readable throughout, and the resumable backfill
-- (`src/server/metadata/backfill.ts`) converts the remainder after start-up.
-- Dropping the plaintext columns is the contract release's migration.
--
-- Nothing here can encrypt: the KEK is an application secret and is not
-- available to SQL.

-- `title` and `email` were NOT NULL. An encrypted row clears its plaintext, so
-- the constraint has to go before the backfill can run; the application, not
-- the database, is what now insists a written item has a title (the read path
-- alone tolerates its absence, and only to render a damaged value's marker).
ALTER TABLE "items" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "title_enc" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "provider_enc" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "cost_minor_enc" text;--> statement-breakpoint
-- Deliberately no blind index on any of the three (ADR-0024 decision 2 asks
-- whether one is needed before one is built). Nothing looks an item up by
-- title, provider or cost: candidate matching, duplicate detection and cost
-- totals all read every row of the household anyway, so an index would serve
-- no query and would leak equality for nothing.
ALTER TABLE "household_invitations" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD COLUMN "email_enc" text;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD COLUMN "email_index" text;--> statement-breakpoint
-- The one Tier 2 blind index, and the reason for it: "one open invitation per
-- address" is enforced by the database today
-- (`household_invitation_open_once`), and clearing the plaintext would quietly
-- retire that rule, because PostgreSQL treats every NULL as distinct. This
-- index carries it across. Both indexes stand through the expand release: the
-- plaintext one still constrains rows the backfill has not reached.
CREATE UNIQUE INDEX "household_invitation_open_once_index" ON "household_invitations" USING btree ("household_id","email_index") WHERE "redeemed_at" IS NULL AND "revoked_at" IS NULL;
