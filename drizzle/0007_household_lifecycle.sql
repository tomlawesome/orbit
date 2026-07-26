ALTER TABLE "households" ADD COLUMN "deletion_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "delete_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "deletion_requested_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_deletion_requested_by_user_id_users_id_fk" FOREIGN KEY ("deletion_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "household_deletion_due_idx" ON "households" USING btree ("delete_after");
