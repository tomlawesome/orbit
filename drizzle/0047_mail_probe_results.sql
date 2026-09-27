CREATE TABLE "mail_probe_results" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_result" text,
	"mailbox_checked_at" timestamp with time zone,
	"relay_result" text,
	"relay_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_probe_results_singleton" CHECK ("singleton")
);
--> statement-breakpoint
-- Seeded unconditionally, like instance_contact (0033, #860): every
-- installation gets exactly one row with no result recorded yet, which is a
-- supported, working state (a pill that has never been tested), so the read
-- is always a plain primary-key lookup rather than a conditional one.
INSERT INTO "mail_probe_results" ("singleton") VALUES (true);
