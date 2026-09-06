-- One relay per user (ADR-0017 decision 2, slice 3, orbit#744). Generations
-- become the owning user's own monotonic counter, so rotating or cutting off
-- one member's address cannot touch another's.
CREATE TABLE "mail_in_relays" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"current_generation" integer DEFAULT 1 NOT NULL,
	"previous_generation" integer,
	"previous_expires_at" timestamp with time zone,
	"ingest_paused_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_in_relay_current_valid" CHECK ("current_generation" > 0),
	CONSTRAINT "mail_in_relay_previous_valid" CHECK ("previous_generation" IS NULL OR ("previous_generation" > 0 AND "previous_generation" < "current_generation")),
	CONSTRAINT "mail_in_relay_previous_pair" CHECK (("previous_generation" IS NULL) = ("previous_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mail_in_relays" ADD CONSTRAINT "mail_in_relays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Which instance alias key derived each digest. The administrator's emergency
-- rotation mints a new alias_key row and leaves the old one in place until the
-- grace it set expires, so a previous-generation row must name its own key
-- rather than assume the mailbox's current one.
ALTER TABLE "imap_recipient_aliases" ADD COLUMN "alias_key_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "imap_recipient_aliases" ADD CONSTRAINT "imap_recipient_aliases_alias_key_secret_id_mail_in_secrets_id_f" FOREIGN KEY ("alias_key_secret_id") REFERENCES "public"."mail_in_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every existing alias row was derived by whatever alias key the mailbox holds
-- now, because slice 2 is the only writer of that key and re-generates it only
-- when the account itself moves (which resets the aliases with it).
UPDATE "imap_recipient_aliases" a
	SET "alias_key_secret_id" = m."alias_key_secret_id"
	FROM "mail_in_mailbox" m
	WHERE m."alias_key_secret_id" IS NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  singleton_current integer;
  singleton_previous integer;
  singleton_previous_expires timestamptz;
BEGIN
  -- Seat every user in the new per-user table at the generations the retired
  -- singleton was serving, so no member's derived address changes: the alias
  -- key bytes are untouched and the HMAC input still names the same
  -- generation. A user who already holds alias rows is seated at their own
  -- highest active generation instead, which is the same number whenever the
  -- singleton and the rows agree and the safer one when they do not.
  SELECT "current_generation", "previous_generation", "previous_expires_at"
    INTO singleton_current, singleton_previous, singleton_previous_expires
    FROM "imap_recipient_rotation_state" WHERE "id" = 1;

  INSERT INTO "mail_in_relays" (
    "user_id", "current_generation", "previous_generation", "previous_expires_at"
  )
  SELECT
    u."id",
    GREATEST(COALESCE(a."highest", 0), COALESCE(singleton_current, 1), 1),
    CASE
      WHEN singleton_previous IS NOT NULL
        AND singleton_previous_expires > now()
        AND singleton_previous < GREATEST(COALESCE(a."highest", 0), COALESCE(singleton_current, 1), 1)
      THEN singleton_previous
    END,
    CASE
      WHEN singleton_previous IS NOT NULL
        AND singleton_previous_expires > now()
        AND singleton_previous < GREATEST(COALESCE(a."highest", 0), COALESCE(singleton_current, 1), 1)
      THEN singleton_previous_expires
    END
  FROM "users" u
  LEFT JOIN (
    SELECT "user_id", max("generation") AS "highest"
    FROM "imap_recipient_aliases"
    WHERE "status" = 'active'
    GROUP BY "user_id"
  ) a ON a."user_id" = u."id"
  ON CONFLICT ("user_id") DO NOTHING;
END $$;
--> statement-breakpoint
-- The singleton is retired with the drift-detection machinery it fed
-- (core/imap-rotation.ts): the database is now the only authority, so there is
-- no second one left to reconcile against.
DROP TABLE "imap_recipient_rotation_state";
