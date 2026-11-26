CREATE TABLE "portable_archive_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"include_documents" boolean DEFAULT false NOT NULL,
	"status" "document_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"lease_token" uuid,
	"last_error" text,
	"failure_code" text,
	"failure_message" text,
	"bytes_total" bigint,
	"bytes_done" bigint DEFAULT 0 NOT NULL,
	"salt" "bytea",
	"key_wrapped" jsonb,
	"key_id" text,
	"archive_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portable_archive_exports" ADD CONSTRAINT "portable_archive_exports_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_archive_exports" ADD CONSTRAINT "portable_archive_exports_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_archive_exports" ADD CONSTRAINT "portable_archive_exports_archive_id_portable_archives_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."portable_archives"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portable_archive_exports_one_live" ON "portable_archive_exports" USING btree ("household_id") WHERE "portable_archive_exports"."status" in ('pending', 'processing', 'retry');--> statement-breakpoint
CREATE INDEX "portable_archive_exports_claim_idx" ON "portable_archive_exports" USING btree ("status","next_attempt_at");