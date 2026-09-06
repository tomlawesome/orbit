-- Attribution by verified sender (ADR-0017 decision 3, slice 4, orbit#745).
--
-- `ALTER TYPE ... ADD VALUE` is safe inside the migrator's transaction on
-- PostgreSQL 12 and later as long as nothing in the same transaction USES the
-- new label. Nothing below does: the first row written as 'unattributed'
-- belongs to a later poll cycle.
ALTER TYPE "public"."imap_ingestion_status" ADD VALUE IF NOT EXISTS 'unattributed';--> statement-breakpoint
CREATE TYPE "public"."mail_in_sender_source" AS ENUM('account', 'sso', 'manual');--> statement-breakpoint
-- The addresses a member may send from. A sender address is a claim, not a
-- credential: nothing attributes until verified_at is set, and the address is
-- unique across the instance because one address attributes to exactly one
-- member.
CREATE TABLE "mail_in_sender_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"source" "mail_in_sender_source" DEFAULT 'manual' NOT NULL,
	"verified_at" timestamp with time zone,
	"verification_token_digest" text,
	"verification_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_in_sender_address_verification_pair" CHECK (("verification_token_digest" IS NULL) = ("verification_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mail_in_sender_addresses" ADD CONSTRAINT "mail_in_sender_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_in_sender_address_unique" ON "mail_in_sender_addresses" USING btree ("address");--> statement-breakpoint
CREATE INDEX "mail_in_sender_address_user_idx" ON "mail_in_sender_addresses" USING btree ("user_id","verified_at");--> statement-breakpoint
-- When each unknown sender was last answered, so the bounded reply cannot
-- become a flood. The address is a digest: an unattributed sender is not a
-- member, and Orbit keeps nothing readable about them.
CREATE TABLE "mail_in_unattributed_replies" (
	"address_sha256" text PRIMARY KEY NOT NULL,
	"last_replied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Whose Authentication-Results verdict this instance believes. Empty means it
-- has not said, and nothing is believed: no sender is authenticated, so no
-- mail is attributed by sender and no reply is ever sent.
ALTER TABLE "mail_in_mailbox" ADD COLUMN "trusted_authserv_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- How an attributed message reached its owner: the verified sender alone, or
-- the sender with the member's own alias corroborating it.
ALTER TABLE "imap_ingestion_messages" ADD COLUMN "attributed_by" text;--> statement-breakpoint
ALTER TABLE "imap_ingestion_messages" ADD CONSTRAINT "imap_message_attributed_by_valid" CHECK ("attributed_by" IS NULL OR "attributed_by" IN ('sender', 'sender_and_alias'));
