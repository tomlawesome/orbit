-- #1333: the desk household screen offered the time zone "America/New York"
-- (a space where the zone database has an underscore), so a household may hold
-- it. It names exactly one zone, so it is repaired to "America/New_York". The
-- engine now refuses the spelling on every write and tolerates whatever is
-- stored on read; this migration only removes the one value known to be a
-- mistake. Every other value, listed or not, is left as it is.
UPDATE "households" SET "timezone" = 'America/New_York' WHERE "timezone" = 'America/New York';
