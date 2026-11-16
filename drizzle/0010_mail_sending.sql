CREATE TYPE "public"."mail_sending_security" AS ENUM('starttls', 'implicit_tls');--> statement-breakpoint
CREATE TYPE "public"."mail_sending_source" AS ENUM('ui', 'imported');--> statement-breakpoint
CREATE TYPE "public"."mail_sending_via" AS ENUM('mailbox', 'account');--> statement-breakpoint
ALTER TYPE "public"."mail_in_secret_kind" ADD VALUE 'smtp_password';--> statement-breakpoint
CREATE TABLE "mail_sending" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"via" "mail_sending_via" NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"security" "mail_sending_security" DEFAULT 'starttls' NOT NULL,
	"account_user" text DEFAULT '' NOT NULL,
	"sender_name" text NOT NULL,
	"sender_address" text NOT NULL,
	"password_secret_id" uuid,
	"source" "mail_sending_source" NOT NULL,
	"set_by_user_id" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_sent_what" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sending_singleton" CHECK ("mail_sending"."singleton"),
	CONSTRAINT "mail_sending_port_range" CHECK ("mail_sending"."port" BETWEEN 1 AND 65535)
);
--> statement-breakpoint
ALTER TABLE "mail_sending" ADD CONSTRAINT "mail_sending_password_secret_id_mail_in_secrets_id_fk" FOREIGN KEY ("password_secret_id") REFERENCES "public"."mail_in_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sending" ADD CONSTRAINT "mail_sending_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;