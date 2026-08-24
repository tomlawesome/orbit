CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"scheduled_start_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"expected_end_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"absorbed_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_window_status_valid" CHECK ("status" IN ('scheduled', 'open', 'resolved', 'cancelled', 'absorbed')),
	CONSTRAINT "maintenance_window_absorbed_into_id_fk" FOREIGN KEY ("absorbed_into_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "maintenance_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "maintenance_update_kind_valid" CHECK ("kind" IN ('scheduled', 'started', 'update', 'resolved')),
	CONSTRAINT "maintenance_update_body_length" CHECK (char_length("body") <= 500),
	CONSTRAINT "maintenance_updates_window_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- At most one open window, enforced by the database rather than by
-- application logic (orbit#585, ADR-0013 decision 1). The worker's absorb
-- path in decision 5 exists so this is never even momentarily contended.
CREATE UNIQUE INDEX "maintenance_window_open_unique" ON "maintenance_windows" USING btree ("status") WHERE "maintenance_windows"."status" = 'open';--> statement-breakpoint
-- The effective-state probe the guard pays on every request, replacing the
-- retired maintenance_notice_pending_starts_idx with the same shape.
CREATE INDEX "maintenance_window_scheduled_start_idx" ON "maintenance_windows" USING btree ("scheduled_start_at") WHERE "maintenance_windows"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "maintenance_update_window_published_idx" ON "maintenance_updates" USING btree ("window_id","published_at","id");--> statement-breakpoint
ALTER TABLE "instance_maintenance" ADD COLUMN "current_window_id" uuid;--> statement-breakpoint
ALTER TABLE "instance_maintenance" ADD CONSTRAINT "instance_maintenance_current_window_id_fk" FOREIGN KEY ("current_window_id") REFERENCES "public"."maintenance_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DO $$
DECLARE
  live record;
  converted uuid;
  notice record;
BEGIN
  -- A live window survives the upgrade as an open window carrying the
  -- message it had already published (orbit#585). The singleton's
  -- expected_end_at is left exactly as it was: it is now denormalised from
  -- this window, and the two must agree from the first moment after the
  -- migration, not from the first mutation after it.
  SELECT "id", "active", "message", "message_published_at", "expected_end_at", "activated_at"
    INTO live FROM "instance_maintenance" WHERE "singleton";
  IF FOUND AND live.active THEN
    converted := gen_random_uuid();
    INSERT INTO "maintenance_windows" ("id", "status", "started_at", "expected_end_at", "created_at", "updated_at")
      VALUES (converted, 'open', COALESCE(live.activated_at, now()), live.expected_end_at,
              COALESCE(live.activated_at, now()), now());
    -- The application never activates without a message, so the fallback is
    -- for a hand-edited row only; body is NOT NULL and inventing nothing is
    -- not an option.
    INSERT INTO "maintenance_updates" ("window_id", "kind", "body", "published_at", "created_at")
      VALUES (converted, 'started', COALESCE(NULLIF(live.message, ''), 'Maintenance is in progress.'),
              COALESCE(live.message_published_at, live.activated_at, now()),
              COALESCE(live.message_published_at, live.activated_at, now()));
    UPDATE "instance_maintenance" SET "current_window_id" = converted WHERE "singleton";
    INSERT INTO "audit_log" ("entity_type", "entity_id", "action", "changes")
      VALUES ('maintenance_window', converted, 'maintenance_window_opened',
              jsonb_build_object('origin', 'migration', 'migration', '0029_maintenance_windows'));
  END IF;

  -- Pending notices become scheduled windows, keeping their own ids so the
  -- audit rows already pointing at them still resolve. Claimed and cancelled
  -- notices are history rather than state: they go with the table, and the
  -- audit rows that recorded them - message text included - are untouched.
  FOR notice IN
    SELECT "id", "message", "starts_at", "expected_end_at", "created_at"
      FROM "maintenance_notices"
     WHERE "activated_at" IS NULL AND "cancelled_at" IS NULL
     ORDER BY "starts_at" ASC, "id" ASC
  LOOP
    INSERT INTO "maintenance_windows" ("id", "status", "scheduled_start_at", "expected_end_at", "created_at", "updated_at")
      VALUES (notice.id, 'scheduled', notice.starts_at, notice.expected_end_at, notice.created_at, now());
    INSERT INTO "maintenance_updates" ("window_id", "kind", "body", "published_at", "created_at")
      VALUES (notice.id, 'scheduled', notice.message, notice.created_at, notice.created_at);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "instance_maintenance" DROP CONSTRAINT "instance_maintenance_message_length";--> statement-breakpoint
ALTER TABLE "instance_maintenance" DROP COLUMN "message";--> statement-breakpoint
ALTER TABLE "instance_maintenance" DROP COLUMN "message_published_at";--> statement-breakpoint
ALTER TABLE "instance_maintenance" DROP COLUMN "activated_at";--> statement-breakpoint
DROP TABLE "maintenance_notices";
