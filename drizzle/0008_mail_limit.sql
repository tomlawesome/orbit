CREATE TABLE "instance_mail_limit" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"max_bytes" integer,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_mail_limit_singleton" CHECK ("instance_mail_limit"."singleton"),
	CONSTRAINT "instance_mail_limit_max_bytes_bounds" CHECK ("instance_mail_limit"."max_bytes" IS NULL OR "instance_mail_limit"."max_bytes" BETWEEN 1048576 AND 52428800)
);
--> statement-breakpoint
INSERT INTO "instance_mail_limit" ("singleton", "max_bytes") VALUES (true, (SELECT "max_bytes" FROM "instance_upload_limit" WHERE "max_bytes" < 26214400 LIMIT 1));
