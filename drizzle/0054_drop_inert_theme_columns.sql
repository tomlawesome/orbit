-- The theme pack (#325) carries light versus dark, and status tokens are flat
-- per pack, so these two preference columns select nothing (owner, #1403 Q2).
ALTER TABLE "user_preferences" DROP COLUMN "theme_mode";--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN "urgency_palette";--> statement-breakpoint
DROP TYPE "theme_mode";
