ALTER TABLE "households" ADD COLUMN "setup_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "households" SET "setup_completed" = true;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "text_size" text DEFAULT 'comfortable' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "urgency_palette" text DEFAULT 'themed' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_instance_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "users"
SET "is_instance_admin" = true
WHERE "id" = (
  SELECT "id"
  FROM "users"
  ORDER BY "created_at", "id"
  LIMIT 1
);
