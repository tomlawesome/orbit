-- #1848 W-R1: the relay rotation limits count one member's
-- mail_in_relay_rotated audit rows in a window; this keeps that count cheap.
CREATE INDEX "audit_relay_rotation_idx" ON "audit_log" USING btree ("actor_user_id","action","created_at") WHERE "audit_log"."entity_type" = 'mail_in_relay';