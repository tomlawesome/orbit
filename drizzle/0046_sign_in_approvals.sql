CREATE TABLE "sign_in_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"claim_hash" text NOT NULL,
	"user_agent" text,
	"client_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"outcome" text,
	"decided_at" timestamp with time zone,
	"send_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"notice_shown_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_approvals_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sign_in_approvals_claim_hash_unique" UNIQUE("claim_hash"),
	CONSTRAINT "sign_in_approvals_outcome" CHECK ("sign_in_approvals"."outcome" IS NULL OR "sign_in_approvals"."outcome" IN ('approved','denied')),
	CONSTRAINT "sign_in_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "sign_in_approvals_user_idx" ON "sign_in_approvals" USING btree ("user_id");
