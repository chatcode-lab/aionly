-- Partners, such as guest editors, bring members with a link of their own,
-- `/join/<code>`, good for many accounts, and get a share of what those
-- members pay for the Fan plan in their first months (see the plan's
-- "Partners"). Each link keeps the terms it was made with.
CREATE TABLE partner_links (
  -- Lowercase letters, digits, `_` and `-`: the link's address.
  code TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES profiles (user_id),
  share_percent INTEGER NOT NULL CHECK (share_percent BETWEEN 0 AND 100),
  share_months INTEGER NOT NULL CHECK (share_months BETWEEN 1 AND 120),
  -- Accounts it may make, or null for no limit.
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  -- When it stops taking sign-ups, or null.
  ends_at INTEGER,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES profiles (user_id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;

CREATE INDEX partner_links_partner ON partner_links (partner_id, created_at DESC);

-- Who joined through which link. Claimed for the account's ID as its
-- sign-up is made, before the account exists, as an invitation is; a
-- claim whose account never came is swept.
CREATE TABLE partner_joins (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES partner_links (code),
  joined_at INTEGER NOT NULL
) STRICT;

CREATE INDEX partner_joins_code ON partner_joins (code, joined_at);

-- What partners were paid of their share.
CREATE TABLE partner_payouts (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES profiles (user_id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  -- The day it was paid, YYYY-MM-DD.
  paid_on TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL REFERENCES profiles (user_id),
  recorded_at INTEGER NOT NULL
) STRICT;

CREATE INDEX partner_payouts_partner ON partner_payouts (partner_id, paid_on DESC);
