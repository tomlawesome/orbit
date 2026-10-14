-- "after-dark" (with the hyphen) was the pre-#325 spelling and was never a
-- theme pack id; the default pack is "afterdark". Existing rows are left as
-- they are: the session reader resolves a stale stored id to the default.
ALTER TABLE "user_preferences" ALTER COLUMN "theme_id" SET DEFAULT 'afterdark';
