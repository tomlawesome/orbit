-- Damaged Tier 1 values become countable (#941, ADR-0024 decision 5).
--
-- A value that fails its integrity check is discoverable only by decrypting
-- it, so an instance cannot say how much of its metadata is damaged without
-- remembering what it has already seen fail. This table is that memory: one
-- row per damaged value, written the first time it refuses to authenticate and
-- deleted when the value is written over, which is the repair.
--
-- The key is the value's own content AAD — table, column, row — so a sighting
-- names exactly one value and never the same row's other encrypted column.
-- There is deliberately no foreign key: `row_id` addresses `items` and
-- `imap_ingestion_messages` alike, and no single reference could cover both.
-- The administrator counts join the owning table instead, so a row that has
-- since been deleted stops counting without a sweep job.
--
-- Additive and empty on arrival: nothing here reads or writes any encrypted
-- value, and an instance with no damage carries an empty table for ever.
CREATE TABLE "metadata_damage_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The sighting is the fact "this value has been seen damaged", not a log of
-- every time it was read: seeing it again must not add a second row.
CREATE UNIQUE INDEX "metadata_damage_sighting_value_unique" ON "metadata_damage_sightings" USING btree ("table_name","column_name","row_id");
