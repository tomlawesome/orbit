CREATE TABLE "instance_upload_limit" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"max_bytes" integer,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_upload_limit_singleton" CHECK ("singleton"),
	CONSTRAINT "instance_upload_limit_max_bytes_bounds" CHECK ("max_bytes" IS NULL OR "max_bytes" BETWEEN 1048576 AND 104857600)
);
--> statement-breakpoint
-- Seeded unconditionally, like instance_contact (0033, #860): every
-- installation - fresh or upgrading - gets exactly one row with no
-- override, so the upload limit is DOCUMENT_MAX_BYTES until an
-- administrator chooses otherwise in Administration (#1285).
INSERT INTO "instance_upload_limit" ("singleton") VALUES (true);
