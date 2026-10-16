-- What members paid, before tax, as Stripe reported it: each plan invoice
-- and each fresh start that applied. Fresh starts are given to charity
-- through the fund, and partners get a share of plan payments (see the
-- plan's "The fund" and "Partners"). Refunds lower `refunded_cents`, before
-- tax too.
CREATE TABLE payments (
  -- Stripe's invoice, or the fresh start's checkout session.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'fresh_start')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  payment_intent TEXT,
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0)
) STRICT;

CREATE INDEX payments_user ON payments (user_id, paid_at);
CREATE INDEX payments_kind ON payments (kind, paid_at);
CREATE INDEX payments_intent ON payments (payment_intent) WHERE payment_intent IS NOT NULL;

-- Paid fresh starts so far, all at $20 before tax.
INSERT INTO payments (id, user_id, kind, amount_cents, currency, paid_at)
SELECT id, user_id, 'fresh_start', 2000, 'usd', applied_at FROM fresh_starts
WHERE source = 'stripe' AND applied_at IS NOT NULL;

-- Whether a member's profile shows what their fresh starts gave.
ALTER TABLE profiles ADD COLUMN show_gift INTEGER NOT NULL DEFAULT 0 CHECK (show_gift IN (0, 1));

-- The cause the fund gives to next, chosen by an admin: the latest row.
CREATE TABLE fund_causes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  why TEXT,
  chosen_by TEXT NOT NULL REFERENCES profiles (user_id),
  chosen_at INTEGER NOT NULL
) STRICT;

CREATE INDEX fund_causes_chosen ON fund_causes (chosen_at DESC);

-- What the fund gave, each with where it went and its receipt.
CREATE TABLE fund_gifts (
  id TEXT PRIMARY KEY,
  -- The day it was given, YYYY-MM-DD.
  given_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  recipient TEXT NOT NULL,
  recipient_url TEXT NOT NULL,
  receipt_url TEXT,
  note TEXT,
  recorded_by TEXT NOT NULL REFERENCES profiles (user_id),
  recorded_at INTEGER NOT NULL
) STRICT;

CREATE INDEX fund_gifts_given ON fund_gifts (given_on DESC);
