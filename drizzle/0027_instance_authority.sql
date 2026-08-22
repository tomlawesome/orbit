CREATE TABLE "instance_authority" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"primary_user_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_authority_singleton" CHECK ("singleton"),
	CONSTRAINT "instance_authority_primary_user_id_users_id_fk" FOREIGN KEY ("primary_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint
DO $$
DECLARE
  chosen uuid;
  user_count integer;
BEGIN
  -- Existing installations migrate deterministically (orbit#263): the
  -- earliest-created active administrator becomes primary, ties broken by id.
  -- A fresh instance has no users and seeds authority at first bootstrap
  -- instead. Users without any active administrator is an invalid authority
  -- state and fails closed rather than guessing.
  SELECT count(*) INTO user_count FROM "users";
  IF user_count = 0 THEN
    RETURN;
  END IF;
  SELECT "id" INTO chosen FROM "users"
    WHERE "is_instance_admin" = true AND "disabled_at" IS NULL
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT 1;
  IF chosen IS NULL THEN
    RAISE EXCEPTION 'instance_authority: users exist but no active administrator; authority state is ambiguous and the migration refuses to guess (orbit#263)';
  END IF;
  INSERT INTO "instance_authority" ("singleton", "primary_user_id") VALUES (true, chosen);
  INSERT INTO "audit_log" ("entity_type", "entity_id", "action", "changes")
    VALUES ('user', chosen, 'primary_administrator_established',
            jsonb_build_object('rule', 'earliest_created_active_administrator', 'migration', '0027_instance_authority'));
END $$;
