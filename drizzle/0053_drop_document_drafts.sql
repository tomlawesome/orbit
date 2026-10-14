-- Document drafts were removed with the draft feature (#1399); nothing reads
-- or writes the table, and no data is held in it (owner, #1403 Q1). Its
-- indexes and foreign keys go with it.
DROP TABLE "document_drafts";--> statement-breakpoint
DROP TYPE "document_draft_status";
