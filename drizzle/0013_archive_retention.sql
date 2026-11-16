CREATE TABLE "instance_archive_retention" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"retention_hours" integer,
	"max_per_household" integer,
	"max_total_bytes" bigint,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_archive_retention_singleton" CHECK ("instance_archive_retention"."singleton"),
	CONSTRAINT "instance_archive_retention_hours_bounds" CHECK ("instance_archive_retention"."retention_hours" IS NULL OR "instance_archive_retention"."retention_hours" BETWEEN 1 AND 720),
	CONSTRAINT "instance_archive_retention_per_household_bounds" CHECK ("instance_archive_retention"."max_per_household" IS NULL OR "instance_archive_retention"."max_per_household" BETWEEN 1 AND 10),
	CONSTRAINT "instance_archive_retention_total_bounds" CHECK ("instance_archive_retention"."max_total_bytes" IS NULL OR "instance_archive_retention"."max_total_bytes" BETWEEN 1073741824 AND 109951162777600)
);
--> statement-breakpoint
INSERT INTO "instance_archive_retention" ("singleton") VALUES (true);
