CREATE INDEX "audit_household_activity_idx" ON "audit_log" USING btree ("household_id","entity_type","created_at");
