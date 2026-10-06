-- Tier 1 metadata encryption, expand phase (ADR-0024, #931 / slice 2 of #365).
--
-- Expand only: every column added here is nullable, every existing column is
-- left in place, and no value is rewritten. The running release reads `*_enc`
-- when it is non-null and the plaintext column otherwise, so every row is
-- readable throughout, and the resumable backfill
-- (`src/server/metadata/backfill.ts`) converts the remainder in small
-- transactions after startup. Dropping the plaintext columns is the contract
-- release's migration, deliberately a release later.
--
-- Nothing here can encrypt: the KEK is an application secret and is not
-- available to SQL. What this migration does for existing rows is guarantee
-- they stay readable — the plaintext stands until the backfill replaces it.
CREATE TYPE "public"."metadata_key_scope" AS ENUM('household', 'instance');--> statement-breakpoint
-- One wrapped metadata DEK per household, plus exactly one instance-scope row
-- for mail-in receipts that are not attributed to a household yet. Envelope
-- columns match `document_crypto` so the rewrap worker (#932) can select both
-- by `key_id` and rewrap them in one transaction.
CREATE TABLE "metadata_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "metadata_key_scope" NOT NULL,
	"household_id" uuid,
	"envelope_version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"wrap_iv" text NOT NULL,
	"wrap_auth_tag" text NOT NULL,
	"key_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_keys_scope_household_valid" CHECK (("scope" = 'household' AND "household_id" IS NOT NULL) OR ("scope" = 'instance' AND "household_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "metadata_keys" ADD CONSTRAINT "metadata_keys_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "metadata_keys_household_unique" ON "metadata_keys" USING btree ("household_id");--> statement-breakpoint
-- PostgreSQL treats every NULL as distinct, so the unique index above does not
-- constrain the instance row. This partial index is what keeps it a singleton.
CREATE UNIQUE INDEX "metadata_keys_instance_unique" ON "metadata_keys" USING btree ("scope") WHERE "household_id" IS NULL;--> statement-breakpoint
CREATE INDEX "metadata_keys_key_id_idx" ON "metadata_keys" USING btree ("key_id");--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reference_enc" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "reference_index" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "notes_enc" text;--> statement-breakpoint
-- Serves blind-index duplicate detection (ADR-0024 decision 2).
CREATE INDEX "item_household_reference_index_idx" ON "items" USING btree ("household_id","reference_index");--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "proposal_enc" text;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "field_evidence_enc" text;
