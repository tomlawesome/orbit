CREATE TYPE "public"."mail_in_secret_kind" AS ENUM('imap_password', 'alias_key', 'oauth_refresh_token');--> statement-breakpoint
CREATE TYPE "public"."mail_in_provider_profile" AS ENUM('mailcow', 'gmail', 'outlook', 'other');--> statement-breakpoint
CREATE TYPE "public"."mail_in_auth_method" AS ENUM('password', 'xoauth2');--> statement-breakpoint
-- One row per app-managed mail-in secret (ADR-0017 decision 1, slice 1): the
-- mailbox password and the instance's alias-derivation key, envelope-
-- encrypted under the document KEK exactly as document_crypto is. A
-- superseded secret is deleted, not kept.
CREATE TABLE "mail_in_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "mail_in_secret_kind" NOT NULL,
	"ciphertext" bytea NOT NULL,
	"envelope_version" integer NOT NULL,
	"content_iv" text NOT NULL,
	"content_auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"wrap_iv" text NOT NULL,
	"wrap_auth_tag" text NOT NULL,
	"key_id" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The instance's one admin-managed mailbox (ADR-0017 decision 1, slice 1):
-- non-secret provider configuration only, following the instance_maintenance
-- shape. No row is seeded: unlike maintenance, "not configured" is a valid
-- and meaningful absence here, and this slice ships no writer for the row
-- (the admin surface is #743). There is no environment import (rescoped,
-- 2026-09-03): there are no existing installs to carry forward.
CREATE TABLE "mail_in_mailbox" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"account_user" text DEFAULT '' NOT NULL,
	"mailbox" text DEFAULT 'INBOX' NOT NULL,
	"tls_server_name" text DEFAULT '' NOT NULL,
	"provider_profile" "mail_in_provider_profile" DEFAULT 'other' NOT NULL,
	"auth_method" "mail_in_auth_method" DEFAULT 'password' NOT NULL,
	"trusted_recipient_header" text DEFAULT '' NOT NULL,
	"poll_seconds" integer DEFAULT 300 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"verification_state" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"password_secret_id" uuid,
	"alias_key_secret_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_in_mailbox_singleton" CHECK ("singleton"),
	CONSTRAINT "mail_in_mailbox_verification_state_valid" CHECK ("verification_state" IN ('unverified', 'verified', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "mail_in_secrets" ADD CONSTRAINT "mail_in_secrets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_in_mailbox" ADD CONSTRAINT "mail_in_mailbox_password_secret_id_mail_in_secrets_id_fk" FOREIGN KEY ("password_secret_id") REFERENCES "public"."mail_in_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_in_mailbox" ADD CONSTRAINT "mail_in_mailbox_alias_key_secret_id_mail_in_secrets_id_fk" FOREIGN KEY ("alias_key_secret_id") REFERENCES "public"."mail_in_secrets"("id") ON DELETE set null ON UPDATE no action;
