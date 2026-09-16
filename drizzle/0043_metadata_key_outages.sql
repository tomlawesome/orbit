-- Durable key-outage windows (#964): the mail-in retention reaper reads this
-- to stop the 45-day clock while metadataCryptoAvailable() is false, so a
-- locked-but-intact receipt is not destroyed on a clock that was never
-- ticking for it. Modelled on maintenance_windows, including its
-- partial-unique-index trick for "at most one open row" -- a plain unique
-- index cannot do that over the nullable ended_at column, since PostgreSQL
-- treats every NULL as distinct.
CREATE TABLE "metadata_key_outages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_key_outage_status_valid" CHECK ("status" IN ('open', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "metadata_key_outage_open_unique" ON "metadata_key_outages" USING btree ("status") WHERE "metadata_key_outages"."status" = 'open';
