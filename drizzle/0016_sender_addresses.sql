CREATE TABLE "mail_in_sender_check_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "mail_in_sender_address_unique_index";--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "held_sender_address_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_in_sender_check_sends" ADD CONSTRAINT "mail_in_sender_check_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_in_sender_check_send_user_idx" ON "mail_in_sender_check_sends" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "imap_message_held_sender_idx" ON "imap_ingestion_messages" USING btree ("held_sender_address_id") WHERE "imap_ingestion_messages"."held_sender_address_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_in_sender_address_user_unique_index" ON "mail_in_sender_addresses" USING btree ("user_id","address_index");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_in_sender_address_unique_index" ON "mail_in_sender_addresses" USING btree ("address_index") WHERE "mail_in_sender_addresses"."verified_at" IS NOT NULL;