CREATE TABLE "instance_contact" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"public_address" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_contact_singleton" CHECK ("singleton"),
	CONSTRAINT "instance_contact_public_address_length" CHECK ("public_address" IS NULL OR char_length("public_address") <= 320)
);
--> statement-breakpoint
-- Seeded unconditionally, like instance_maintenance (0028, #522): every
-- installation - fresh or upgrading - gets exactly one row with no address,
-- which is a supported, working state (#860), so the guard read is always a
-- plain primary-key lookup rather than a conditional one.
INSERT INTO "instance_contact" ("singleton") VALUES (true);
