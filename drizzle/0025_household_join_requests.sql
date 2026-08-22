CREATE TYPE "public"."join_request_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "household_join_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "household_join_requests" ADD CONSTRAINT "household_join_requests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_join_requests" ADD CONSTRAINT "household_join_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_join_requests" ADD CONSTRAINT "household_join_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_request_pending_once" ON "household_join_requests" USING btree ("household_id","user_id") WHERE "household_join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "join_request_household_idx" ON "household_join_requests" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "join_request_user_idx" ON "household_join_requests" USING btree ("user_id","status");
