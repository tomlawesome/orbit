ALTER TABLE "user_preferences" ADD COLUMN "first_warning_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "final_warning_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preference_warning_days_bounded" CHECK ("first_warning_days" BETWEEN 1 AND 365 AND "final_warning_days" BETWEEN 0 AND 365);--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preference_final_warning_last" CHECK ("final_warning_days" < "first_warning_days");
