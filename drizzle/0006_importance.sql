ALTER TABLE "items" ADD COLUMN "importance" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "planet_size" text DEFAULT 'cost' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "importance_offer_dismissed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "item_importance_known" CHECK ("items"."importance" IN ('low', 'normal', 'high'));--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preference_planet_size_known" CHECK ("user_preferences"."planet_size" IN ('cost', 'importance'));