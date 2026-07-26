ALTER TABLE "imap_ingestion_messages" ADD COLUMN "receipt_status" "delivery_status" DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "receipt_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "receipt_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "receipt_failure_code" text;--> statement-breakpoint
CREATE INDEX "imap_receipt_delivery_idx" ON "imap_ingestion_messages" USING btree ("receipt_status", "created_at");
