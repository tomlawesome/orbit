-- One-off expirations become a third schedule kind (#1005). A warranty, a
-- guarantee or a fixed-term agreement has an end date that never comes round,
-- so its due event needs a label of its own: `renewal` would promise a repeat
-- and `service` would promise a visit.
--
-- `ALTER TYPE ... ADD VALUE` is safe inside the migrator's transaction on
-- PostgreSQL 12 and later as long as nothing in the same transaction uses the
-- new label. Nothing below does -- there is nothing below.
ALTER TYPE "public"."event_kind" ADD VALUE IF NOT EXISTS 'expiry';
