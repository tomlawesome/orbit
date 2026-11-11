-- #1433: kept page previews. The job kind enum is recreated rather than
-- extended with ADD VALUE: the migrator runs every pending migration in one
-- transaction, and PostgreSQL refuses a value added by ADD VALUE until that
-- transaction commits, so the backfill below could not name 'preview'.
-- A type created in this transaction can be used at once.
ALTER TYPE "public"."document_job_kind" RENAME TO "document_job_kind_before_previews";--> statement-breakpoint
CREATE TYPE "public"."document_job_kind" AS ENUM('scan', 'encrypt', 'purge', 'reconcile', 'rewrap', 'preview');--> statement-breakpoint
ALTER TABLE "document_jobs" ALTER COLUMN "kind" TYPE "public"."document_job_kind" USING "kind"::text::"public"."document_job_kind";--> statement-breakpoint
DROP TYPE "public"."document_job_kind_before_previews";--> statement-breakpoint
CREATE TABLE "document_previews" (
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"status" text NOT NULL,
	"refusal" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"renderer" text NOT NULL,
	"media_type" text,
	"width" integer,
	"height" integer,
	"plaintext_size" integer,
	"ciphertext_size" integer,
	"storage_key" text,
	"envelope_version" integer,
	"content_iv" text,
	"content_auth_tag" text,
	"wrapped_dek" text,
	"wrap_iv" text,
	"wrap_auth_tag" text,
	"key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_previews_document_id_page_pk" PRIMARY KEY("document_id","page"),
	CONSTRAINT "document_preview_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "document_preview_page_positive" CHECK ("document_previews"."page" >= 1),
	CONSTRAINT "document_preview_status_valid" CHECK ("document_previews"."status" IN ('drawn', 'refused')),
	CONSTRAINT "document_preview_refusal_valid" CHECK ("document_previews"."refusal" IS NULL OR "document_previews"."refusal" IN ('memory', 'timeout', 'crash', 'parser', 'unsupported')),
	CONSTRAINT "document_preview_shape" CHECK (("document_previews"."status" = 'drawn' AND "document_previews"."refusal" IS NULL AND "document_previews"."storage_key" IS NOT NULL AND "document_previews"."media_type" IS NOT NULL AND "document_previews"."plaintext_size" IS NOT NULL AND "document_previews"."ciphertext_size" IS NOT NULL AND "document_previews"."envelope_version" IS NOT NULL AND "document_previews"."content_iv" IS NOT NULL AND "document_previews"."content_auth_tag" IS NOT NULL AND "document_previews"."wrapped_dek" IS NOT NULL AND "document_previews"."wrap_iv" IS NOT NULL AND "document_previews"."wrap_auth_tag" IS NOT NULL AND "document_previews"."key_id" IS NOT NULL) OR ("document_previews"."status" = 'refused' AND "document_previews"."refusal" IS NOT NULL AND "document_previews"."storage_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "document_previews" ADD CONSTRAINT "document_previews_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_preview_key_idx" ON "document_previews" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "document_preview_status_idx" ON "document_previews" USING btree ("status");--> statement-breakpoint
-- Backfill (#1433 D13): one pending preview job per readable document, so an
-- upgrade draws every existing document in the background, lowest priority.
INSERT INTO "document_jobs" ("document_id", "kind", "generation", "status")
SELECT "id", 'preview', 1, 'pending'
FROM "documents"
WHERE "lifecycle" IN ('available', 'pending_deletion')
ON CONFLICT ("document_id", "kind", "generation") DO NOTHING;