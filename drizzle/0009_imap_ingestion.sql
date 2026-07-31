CREATE TYPE "public"."imap_ingestion_status" AS ENUM('pending_review', 'quarantined', 'failed');--> statement-breakpoint
CREATE TABLE "imap_ingestion_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox" text NOT NULL,
	"mailbox_uid_validity" text NOT NULL,
	"mailbox_uid" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"recipient_alias_sha256" text NOT NULL,
	"user_id" uuid,
	"status" "imap_ingestion_status" NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"failure_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD CONSTRAINT "imap_ingestion_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "imap_message_mailbox_uid_unique" ON "imap_ingestion_messages" USING btree ("mailbox","mailbox_uid_validity","mailbox_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "imap_message_content_unique" ON "imap_ingestion_messages" USING btree ("content_sha256");--> statement-breakpoint
CREATE INDEX "imap_message_user_status_idx" ON "imap_ingestion_messages" USING btree ("user_id","status","received_at");
