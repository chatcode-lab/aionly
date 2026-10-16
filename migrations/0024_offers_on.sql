-- Offers by email are on for members unless they turn them off (see the
-- plan's "Offer emails"): when they did, or null. Members who joined while
-- offers needed a yes, and gave none, count as having said no.
ALTER TABLE profiles ADD COLUMN offers_off_at INTEGER;
UPDATE profiles SET offers_off_at = unixepoch() WHERE offers_consent_at IS NULL;
ALTER TABLE profiles DROP COLUMN offers_consent_at;
