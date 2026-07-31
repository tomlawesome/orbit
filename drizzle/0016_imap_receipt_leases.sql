ALTER TABLE "imap_ingestion_messages" ADD COLUMN "receipt_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "receipt_lease_token" uuid;--> statement-breakpoint
CREATE INDEX "imap_receipt_claim_idx" ON "imap_ingestion_messages" USING btree ("receipt_status", "receipt_locked_at", "created_at");
