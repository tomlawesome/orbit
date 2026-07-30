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
WHERE "review_item_id" IS NOT NULL AND "status" NOT IN ('completed', 'discarded');--> statement-breakpoint
UPDATE "imap_ingestion_messages"
SET "approved_item_id" = "review_item_id"
WHERE "review_item_id" IS NOT NULL AND "status" = 'completed';--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD CONSTRAINT "imap_ingestion_messages_approved_item_id_items_id_fk"
  FOREIGN KEY ("approved_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imap_message_approval_operation_unique" ON "imap_ingestion_messages" USING btree ("approval_operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "imap_message_approval_result_unique" ON "imap_ingestion_messages" USING btree ("approval_result_id");--> statement-breakpoint
CREATE INDEX "imap_message_expiry_idx" ON "imap_ingestion_messages" USING btree ("status", "expires_at");--> statement-breakpoint
CREATE INDEX "imap_message_approved_item_idx" ON "imap_ingestion_messages" USING btree ("approved_item_id");--> statement-breakpoint
CREATE TYPE "public"."reviewed_intake_operation_status" AS ENUM('processing', 'pending_attachment', 'completed', 'recoverable', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reviewed_intake_operation_source" AS ENUM('direct_upload', 'mailbox_draft');--> statement-breakpoint
CREATE TYPE "public"."reviewed_intake_attachment_state" AS ENUM('not_requested', 'pending', 'attached');--> statement-breakpoint
CREATE TABLE "reviewed_intake_operations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "source" "reviewed_intake_operation_source" NOT NULL,
  "household_id" uuid NOT NULL,
  "section_id" uuid NOT NULL,
  "action" text NOT NULL,
  "target_item_id" uuid,
  "item_id" uuid NOT NULL,
  "request_sha256" text NOT NULL,
  "result_id" uuid NOT NULL,
  "expected_document" boolean DEFAULT false NOT NULL,
  "attachment_state" "reviewed_intake_attachment_state" DEFAULT 'not_requested' NOT NULL,
  "document_id" uuid,
  "status" "reviewed_intake_operation_status" NOT NULL,
  "failure_code" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "reviewed_intake_operations" ADD CONSTRAINT "reviewed_intake_operations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_intake_operations" ADD CONSTRAINT "reviewed_intake_operations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_intake_operations" ADD CONSTRAINT "reviewed_intake_operations_target_item_id_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_intake_operations" ADD CONSTRAINT "reviewed_intake_operations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewed_intake_operation_result_unique" ON "reviewed_intake_operations" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "reviewed_intake_operation_actor_idx" ON "reviewed_intake_operations" USING btree ("actor_user_id", "created_at");--> statement-breakpoint
CREATE INDEX "reviewed_intake_operation_item_idx" ON "reviewed_intake_operations" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "transfer_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "transfer_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "transfer_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "purge_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD COLUMN "purge_failure_code" text;
