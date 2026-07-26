CREATE TABLE "portable_archives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "household_id" uuid NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "storage_key" text NOT NULL,
  "content_sha256" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "includes_documents" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "downloaded_at" timestamp with time zone,
  "purged_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "portable_archives_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "portable_archives" ADD CONSTRAINT "portable_archives_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "portable_archives" ADD CONSTRAINT "portable_archives_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "portable_archive_expiry_idx" ON "portable_archives" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "portable_archive_household_created_idx" ON "portable_archives" USING btree ("household_id", "created_at");
