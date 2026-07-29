ALTER TYPE "public"."imap_ingestion_status" ADD VALUE IF NOT EXISTS 'approving';--> statement-breakpoint
ALTER TYPE "public"."imap_ingestion_status" ADD VALUE IF NOT EXISTS 'recoverable';--> statement-breakpoint
ALTER TYPE "public"."imap_ingestion_status" ADD VALUE IF NOT EXISTS 'expired';--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "draft_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "proposal" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "field_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "approval_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "approval_result_id" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "approval_request_sha256" text;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "approved_item_id" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "approval_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "discarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
UPDATE "imap_ingestion_messages"
SET "expires_at" = COALESCE("received_at", "created_at") + interval '30 days'
WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days');--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
UPDATE "imap_ingestion_messages"
SET "status" = 'failed', "failure_code" = 'legacy_review_item', "updated_at" = now()
WHERE "review_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD CONSTRAINT "imap_ingestion_messages_approved_item_id_items_id_fk"
  FOREIGN KEY ("approved_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imap_message_approval_operation_unique" ON "imap_ingestion_messages" USING btree ("approval_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imap_message_approval_result_unique" ON "imap_ingestion_messages" USING btree ("approval_result_id");--> statement-breakpoint
CREATE INDEX "imap_message_expiry_idx" ON "imap_ingestion_messages" USING btree ("status", "expires_at");--> statement-breakpoint
CREATE INDEX "imap_message_approved_item_idx" ON "imap_ingestion_messages" USING btree ("approved_item_id");
