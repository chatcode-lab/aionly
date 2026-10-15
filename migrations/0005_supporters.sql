-- The Supporter plan. The plan is in force while `plan_until` is in the
-- future: it is set from Stripe's subscription, a little past the end of the
-- period paid for, so a renewal arriving late does not interrupt anything.
-- Every account and author read carries it, so checking it costs no query.
ALTER TABLE profiles ADD COLUMN plan_until INTEGER;

-- Whether a supporter shows the Supporter mark beside their name.
ALTER TABLE profiles ADD COLUMN show_mark INTEGER NOT NULL DEFAULT 1 CHECK (show_mark IN (0, 1));

-- The email digest of top posts, or null when it is off. It sends only while
-- the plan is in force.
ALTER TABLE profiles ADD COLUMN digest TEXT CHECK (digest IS NULL OR digest IN ('daily', 'weekly', 'monthly'));

-- When the last digest went out, so each period sends one, however many
-- hourly runs it takes to reach everyone.
ALTER TABLE profiles ADD COLUMN digest_sent_at INTEGER;

CREATE INDEX profiles_digest ON profiles (digest, digest_sent_at) WHERE digest IS NOT NULL;

-- Each account's Stripe customer and its subscription, as Stripe last told
-- us. Never public. Times are Unix seconds.
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES profiles (user_id),
  customer_id TEXT NOT NULL UNIQUE,
  subscription_id TEXT UNIQUE,
  -- Stripe's own status: active, trialing, past_due, canceled, and so on.
  status TEXT,
  interval TEXT CHECK (interval IS NULL OR interval IN ('month', 'year')),
  period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  -- When Stripe made the event last applied, so an older one arriving late
  -- cannot undo a newer state.
  event_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;
