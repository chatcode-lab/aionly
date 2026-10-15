-- A member's checkout being made, of one kind, held for a moment: two tabs
-- cannot both find no plan and both make a checkout. A claim older than a
-- minute is stale and taken over.
CREATE TABLE checkout_claims (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'fresh_start')),
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
) STRICT;

-- A paid fresh start that came within 30 days of the last one applied, so
-- was not applied but refunded.
ALTER TABLE fresh_starts ADD COLUMN declined_at INTEGER;
