CREATE TABLE "sign_in_approval_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sign_in_approval_sends" ADD CONSTRAINT "sign_in_approval_sends_approval_id_sign_in_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."sign_in_approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_approval_sends" ADD CONSTRAINT "sign_in_approval_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_approval_sends_user_sent_idx" ON "sign_in_approval_sends" USING btree ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "sign_in_approval_sends_approval_idx" ON "sign_in_approval_sends" USING btree ("approval_id");