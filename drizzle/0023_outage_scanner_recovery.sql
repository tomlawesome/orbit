ALTER TABLE "document_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "document_job_claim_idx";--> statement-breakpoint
CREATE INDEX "document_job_claim_idx" ON "document_jobs" USING btree ("status", "next_attempt_at", "created_at");--> statement-breakpoint
CREATE TABLE "document_staging_objects" (
  "document_id" uuid PRIMARY KEY NOT NULL,
  "storage_key" text NOT NULL,
  "purpose" text DEFAULT 'scanner_recovery' NOT NULL,
  "ciphertext_size" integer NOT NULL,
  "envelope_version" integer NOT NULL,
  "content_iv" text NOT NULL,
  "content_auth_tag" text NOT NULL,
  "wrapped_dek" text NOT NULL,
  "wrap_iv" text NOT NULL,
  "wrap_auth_tag" text NOT NULL,
  "key_id" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "recovery_expires_at" timestamp with time zone NOT NULL,
  "purge_attempts" integer DEFAULT 0 NOT NULL,
  "purge_failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_staging_purpose_valid" CHECK ("purpose" = 'scanner_recovery'),
  CONSTRAINT "document_staging_status_valid" CHECK ("status" IN ('pending', 'purge_pending'))
);--> statement-breakpoint
ALTER TABLE "document_staging_objects" ADD CONSTRAINT "document_staging_objects_document_id_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_staging_objects" ADD CONSTRAINT "document_staging_objects_storage_key_unique" UNIQUE ("storage_key");--> statement-breakpoint
CREATE INDEX "document_staging_expiry_idx" ON "document_staging_objects" USING btree ("status", "recovery_expires_at");
