ALTER TABLE "documents" ADD COLUMN "content_index" text;--> statement-breakpoint
CREATE INDEX "document_household_content_index_idx" ON "documents" USING btree ("household_id","content_index");