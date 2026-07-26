CREATE TYPE "public"."imap_attachment_status" AS ENUM('stored', 'rejected', 'assigned');--> statement-breakpoint
CREATE TABLE "imap_ingestion_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"ciphertext_size" integer NOT NULL,
	"envelope_version" integer NOT NULL,
	"content_iv" text NOT NULL,
	"content_auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"wrap_iv" text NOT NULL,
	"wrap_auth_tag" text NOT NULL,
	"key_id" text NOT NULL,
	"status" "imap_attachment_status" DEFAULT 'stored' NOT NULL,
	"assigned_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imap_attachment_message_hash_unique" UNIQUE("message_id","content_sha256"),
	CONSTRAINT "imap_ingestion_attachments_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD CONSTRAINT "imap_ingestion_attachments_message_id_imap_ingestion_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."imap_ingestion_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imap_ingestion_attachments" ADD CONSTRAINT "imap_ingestion_attachments_assigned_document_id_documents_id_fk" FOREIGN KEY ("assigned_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imap_attachment_message_status_idx" ON "imap_ingestion_attachments" USING btree ("message_id","status");
