CREATE TYPE "public"."document_job_kind" AS ENUM('scan', 'encrypt', 'purge', 'reconcile', 'rewrap');--> statement-breakpoint
CREATE TYPE "public"."document_job_status" AS ENUM('pending', 'processing', 'retry', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."document_lifecycle" AS ENUM('receiving', 'validating', 'quarantined', 'scanning', 'encrypting', 'available', 'pending_deletion', 'deleted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."document_scan_status" AS ENUM('pending', 'clean', 'infected', 'error', 'skipped');--> statement-breakpoint
CREATE TABLE "document_crypto" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"ciphertext_size" integer NOT NULL,
	"envelope_version" integer NOT NULL,
	"content_iv" text NOT NULL,
	"content_auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"wrap_iv" text NOT NULL,
	"wrap_auth_tag" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "document_job_kind" NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" "document_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"item_id" uuid,
	"uploaded_by_user_id" uuid,
	"display_name" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"lifecycle" "document_lifecycle" DEFAULT 'receiving' NOT NULL,
	"scan_status" "document_scan_status" DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"delete_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"available_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_crypto" ADD CONSTRAINT "document_crypto_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD CONSTRAINT "document_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_crypto_storage_key_unique" ON "document_crypto" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "document_job_once" ON "document_jobs" USING btree ("document_id","kind","generation");--> statement-breakpoint
CREATE INDEX "document_job_claim_idx" ON "document_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "document_job_lease_idx" ON "document_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "document_household_item_created_idx" ON "documents" USING btree ("household_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "document_household_lifecycle_created_idx" ON "documents" USING btree ("household_id","lifecycle","created_at");