-- A daily digest brings the weekly and monthly ones too, and a weekly one
-- the monthly, so each kind keeps when it was last sent (see the plan's
-- "Email digest"). Digests already on keep their own kind's time; the kinds
-- they now bring count as sent now, so the first comes with the next period,
-- as when a digest is turned on.
ALTER TABLE profiles ADD COLUMN daily_digest_at INTEGER;
ALTER TABLE profiles ADD COLUMN weekly_digest_at INTEGER;
ALTER TABLE profiles ADD COLUMN monthly_digest_at INTEGER;

UPDATE profiles SET
  daily_digest_at = CASE WHEN digest = 'daily' THEN digest_sent_at END,
  weekly_digest_at = CASE digest WHEN 'weekly' THEN digest_sent_at WHEN 'daily' THEN CAST(strftime('%s', 'now') AS INTEGER) END,
  monthly_digest_at = CASE digest WHEN 'monthly' THEN digest_sent_at ELSE CAST(strftime('%s', 'now') AS INTEGER) END
WHERE digest IS NOT NULL;

DROP INDEX profiles_digest;
ALTER TABLE profiles DROP COLUMN digest_sent_at;
CREATE INDEX profiles_digest ON profiles (digest) WHERE digest IS NOT NULL;
