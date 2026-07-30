CREATE TYPE "public"."imap_notification_kind" AS ENUM('receipt', 'review_ready');--> statement-breakpoint
CREATE TABLE "imap_notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "kind" "imap_notification_kind" NOT NULL,
  "status" "delivery_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "locked_at" timestamp with time zone,
  "lease_token" uuid,
  "sent_at" timestamp with time zone,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "imap_notification_deliveries_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."imap_ingestion_messages"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "imap_notification_deliveries_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX "imap_notification_message_kind_unique" ON "imap_notification_deliveries" USING btree ("message_id", "kind");--> statement-breakpoint
CREATE INDEX "imap_notification_claim_idx" ON "imap_notification_deliveries" USING btree ("status", "next_attempt_at", "locked_at");
