ALTER TABLE "documents" ADD COLUMN "bound_at" timestamp with time zone;--> statement-breakpoint
-- Backfill (#1871): a document an item holds, or one no item holds that is not
-- a live staged upload (hold cleared, pending deletion or deleted: kept, since
-- the two are indistinguishable), counts as claimed. Only an item-less row
-- still carrying its staged hold stays null.
UPDATE "documents" SET "bound_at" = "created_at"
WHERE "item_id" IS NOT NULL
   OR "delete_after" IS NULL
   OR "lifecycle" IN ('pending_deletion', 'deleted');
