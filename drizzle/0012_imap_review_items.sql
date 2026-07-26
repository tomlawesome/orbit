ALTER TABLE "items" ADD COLUMN "requires_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "review_item_id" uuid;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD CONSTRAINT "imap_ingestion_messages_review_item_id_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imap_ingestion_review_item_idx" ON "imap_ingestion_messages" USING btree ("review_item_id");
