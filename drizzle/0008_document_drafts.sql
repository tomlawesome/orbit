CREATE TYPE "public"."document_draft_status" AS ENUM('pending_review', 'approved', 'discarded');
--> statement-breakpoint
CREATE TABLE "document_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL,
  "household_id" uuid NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "status" "document_draft_status" DEFAULT 'pending_review' NOT NULL,
  "extracted_text_sha256" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "proposal" jsonb NOT NULL,
  "approved_item_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_draft_document_unique" UNIQUE("document_id")
);
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_approved_item_id_items_id_fk" FOREIGN KEY ("approved_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "document_draft_household_status_idx" ON "document_drafts" USING btree ("household_id","status");
