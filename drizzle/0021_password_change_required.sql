ALTER TABLE "local_credentials" ADD COLUMN "password_change_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sign_in_approvals" DROP COLUMN "notice_shown_at";