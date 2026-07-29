CREATE TYPE "public"."imap_recipient_alias_status" AS ENUM('active', 'legacy_inactive');--> statement-breakpoint
CREATE TABLE "imap_recipient_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"alias_sha256" text NOT NULL,
	"status" "imap_recipient_alias_status" DEFAULT 'active' NOT NULL,
	"active_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imap_recipient_alias_generation_valid" CHECK ("generation" > 0 OR "status" = 'legacy_inactive')
);
--> statement-breakpoint
ALTER TABLE "imap_recipient_aliases" ADD CONSTRAINT "imap_recipient_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "imap_recipient_aliases" ("user_id", "generation", "alias_sha256", "status", "active_until")
SELECT "id", 0, "imap_recipient_alias_sha256", 'legacy_inactive', now()
FROM "users"
WHERE "imap_recipient_alias_sha256" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "imap_recipient_alias_sha256";--> statement-breakpoint
CREATE UNIQUE INDEX "imap_recipient_alias_user_generation_unique" ON "imap_recipient_aliases" USING btree ("user_id", "generation");--> statement-breakpoint
CREATE UNIQUE INDEX "imap_recipient_alias_active_digest_unique" ON "imap_recipient_aliases" USING btree ("generation", "alias_sha256") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "imap_recipient_alias_user_status_idx" ON "imap_recipient_aliases" USING btree ("user_id", "status");--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "recipient_alias_generation" integer;--> statement-breakpoint
DROP INDEX "imap_message_content_unique";--> statement-breakpoint
CREATE INDEX "imap_message_recipient_content_idx" ON "imap_ingestion_messages" USING btree ("user_id", "content_sha256");
