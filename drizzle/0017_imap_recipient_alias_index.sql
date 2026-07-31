ALTER TABLE "users" ADD COLUMN "imap_recipient_alias_sha256" text;--> statement-breakpoint
CREATE INDEX "user_imap_alias_lookup_idx" ON "users" USING btree ("imap_recipient_alias_sha256");
