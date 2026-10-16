-- Offers by email go only to members who said yes (see the plan's "Offer
-- emails"): when they did, at the welcome step or in Settings, or null.
-- Nobody has yet, so the opt-out flag of 0022 goes.
ALTER TABLE profiles ADD COLUMN offers_consent_at INTEGER;
ALTER TABLE profiles DROP COLUMN offers_email;

-- When the notice that the account became read-only by its karma went out.
-- Cleared once karma is back above the floor, a week after at the soonest,
-- so each fall to the floor sends one. Accounts at their floor now are
-- counted as told.
ALTER TABLE profiles ADD COLUMN floor_emailed_at INTEGER;
UPDATE profiles SET floor_emailed_at = unixepoch()
WHERE karma <= COALESCE(karma_floor, (SELECT value FROM settings WHERE key = 'karma_floor'), -100);
-- The few accounts below zero, where the hourly run looks for them.
CREATE INDEX profiles_low_karma ON profiles (karma) WHERE karma < 0;

-- Checkout returns that applied the short name the checkout carried, so a
-- second visit to the same return address changes nothing.
CREATE TABLE checkout_returns (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  done_at INTEGER NOT NULL
) STRICT;
