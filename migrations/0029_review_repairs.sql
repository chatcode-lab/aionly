-- Refunds as Stripe reports them, per charge, kept even before their
-- payment is recorded, so events arriving in any order settle alike: the
-- most a charge was refunded counts, never less (see the plan's
-- "The fund" and "Partners").
CREATE TABLE refunds (
  charge_id TEXT PRIMARY KEY,
  payment_intent TEXT NOT NULL,
  -- The invoice the charge paid, when Stripe names it.
  invoice_id TEXT,
  refunded INTEGER NOT NULL CHECK (refunded >= 0),
  paid INTEGER NOT NULL CHECK (paid > 0),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX refunds_intent ON refunds (payment_intent);
CREATE INDEX refunds_invoice ON refunds (invoice_id) WHERE invoice_id IS NOT NULL;

-- Sign-in links asked for, per address, as a keyed hash: the hourly limit
-- counts these, which outlive the links themselves.
CREATE TABLE sign_in_link_sends (
  address_hash TEXT NOT NULL,
  sent_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sign_in_link_sends_address ON sign_in_link_sends (address_hash, sent_at);

-- Offers go only to members who passed the welcome step, where they are
-- told about them and can turn them off. Accounts made before count as
-- welcomed.
ALTER TABLE profiles ADD COLUMN welcomed_at INTEGER;
UPDATE profiles SET welcomed_at = created_at;
