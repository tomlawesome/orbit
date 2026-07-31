ALTER TYPE "public"."imap_ingestion_status" ADD VALUE IF NOT EXISTS 'processing' BEFORE 'pending_review';--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "attachment_processing_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "attachment_processing_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "attachment_processing_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "attachment_processing_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "attachment_processing_failure_code" text;--> statement-breakpoint
CREATE INDEX "imap_attachment_processing_claim_idx" ON "imap_ingestion_messages" USING btree ("status","attachment_processing_locked_at","created_at");
--> statement-breakpoint
CREATE TABLE "imap_ingestion_staging_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL,
  "lease_token" uuid NOT NULL,
  "storage_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "purge_attempts" integer DEFAULT 0 NOT NULL,
  "purge_failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "imap_staging_object_status_valid" CHECK ("status" IN ('pending', 'committed', 'purge_pending'))
);--> statement-breakpoint
ALTER TABLE "imap_ingestion_staging_objects" ADD CONSTRAINT "imap_staging_objects_message_id_fk"
  FOREIGN KEY ("message_id") REFERENCES "public"."imap_ingestion_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imap_ingestion_staging_objects" ADD CONSTRAINT "imap_ingestion_staging_objects_storage_key_unique" UNIQUE ("storage_key");--> statement-breakpoint
CREATE INDEX "imap_staging_object_message_status_idx" ON "imap_ingestion_staging_objects" USING btree ("message_id", "status");--> statement-breakpoint
CREATE INDEX "imap_staging_object_created_idx" ON "imap_ingestion_staging_objects" USING btree ("status", "created_at");
