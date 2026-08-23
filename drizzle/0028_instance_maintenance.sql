CREATE TABLE "instance_maintenance" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"message" text,
	"message_published_at" timestamp with time zone,
	"expected_end_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_maintenance_singleton" CHECK ("singleton"),
	CONSTRAINT "instance_maintenance_message_length" CHECK ("message" IS NULL OR char_length("message") <= 500)
);
--> statement-breakpoint
CREATE TABLE "maintenance_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expected_end_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_notice_message_length" CHECK (char_length("message") <= 500)
);
--> statement-breakpoint
CREATE INDEX "maintenance_notice_pending_starts_idx" ON "maintenance_notices" USING btree ("starts_at") WHERE "maintenance_notices"."activated_at" IS NULL AND "maintenance_notices"."cancelled_at" IS NULL;--> statement-breakpoint
-- The singleton is seeded unconditionally (orbit#522): unlike
-- instance_authority (#263), maintenance state has no foreign key to an
-- existing row, so every installation - fresh or upgrading - gets exactly
-- one inactive row and the guard read (ADR-0013) is always a plain
-- primary-key lookup, never a conditional one.
INSERT INTO "instance_maintenance" ("singleton") VALUES (true);
