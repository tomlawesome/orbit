CREATE TABLE "household_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"invited_by_user_id" uuid,
	"token_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"send_error" text,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_invitation_send_error_valid" CHECK ("household_invitations"."send_error" IS NULL OR "household_invitations"."send_error" IN ('smtp_unconfigured', 'smtp_unavailable', 'smtp_rejected', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invitations" ADD CONSTRAINT "household_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "household_invitation_open_once" ON "household_invitations" USING btree ("household_id","email") WHERE "household_invitations"."redeemed_at" IS NULL AND "household_invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "household_invitation_token_digest_unique" ON "household_invitations" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "household_invitation_household_idx" ON "household_invitations" USING btree ("household_id","created_at");
