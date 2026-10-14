-- The rate limit on the sender check email (#1403 D2, owner 2026-10-14): one
-- a minute and five in a rolling 24 hours per member. The times of the last
-- five sends live on the member's one address row, so a restart does not
-- forget them (same reasoning as local sign-in lockout, ADR-0023 section 4).
-- Existing rows start with no sends recorded.
ALTER TABLE "mail_in_sender_addresses" ADD COLUMN "check_sent_at" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL;
