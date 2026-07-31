ALTER TYPE "public"."document_job_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_household_id_households_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "household_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "document_jobs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;
