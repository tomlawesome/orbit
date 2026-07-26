ALTER TABLE "imap_ingestion_messages" ADD COLUMN "household_id" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD CONSTRAINT "imap_ingestion_messages_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imap_message_household_status_idx" ON "imap_ingestion_messages" USING btree ("household_id","status","received_at");
