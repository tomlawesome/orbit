ALTER TABLE "user_preferences" ADD COLUMN "whats_new_seen_version" text;--> statement-breakpoint
-- Backfill (#1618): everyone who existed before the what's-new notice is "last seen v0.0.0", so they see the first notes. A user with no preferences row gets one; every other column has a default.
INSERT INTO "user_preferences" ("user_id", "whats_new_seen_version") SELECT "id", 'v0.0.0' FROM "users" ON CONFLICT ("user_id") DO UPDATE SET "whats_new_seen_version" = 'v0.0.0';
