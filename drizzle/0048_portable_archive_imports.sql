CREATE TABLE "portable_archive_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"created_section_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_item_ids" uuid[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "portable_archive_imports_outcome" CHECK ("portable_archive_imports"."outcome" IS NULL OR "portable_archive_imports"."outcome" IN ('completed','rolled_back'))
);
--> statement-breakpoint
ALTER TABLE "portable_archive_imports" ADD CONSTRAINT "portable_archive_imports_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "portable_archive_imports" ADD CONSTRAINT "portable_archive_imports_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "portable_archive_import_household_idx" ON "portable_archive_imports" USING btree ("household_id","finished_at");
