-- Short names, invitations by level, and partner shares in steps (owner's
-- decisions, 19 October 2026; see the plan's "Usernames", "Invitations",
-- and "Partners").

-- The 4-letter username: bought once, kept for good. The shortest length
-- of name it lets the account take, or null. A later, shorter one may lower it.
ALTER TABLE profiles ADD COLUMN name_allowance INTEGER CHECK (name_allowance IS NULL OR name_allowance BETWEEN 1 AND 5);

-- How far down the invitation tree the account is: 0 without an inviter,
-- one more than its inviter's otherwise. Free invitations follow it.
ALTER TABLE profiles ADD COLUMN invite_depth INTEGER NOT NULL DEFAULT 0 CHECK (invite_depth >= 0);

-- Free invitations a partner link gave the account, in place of its level's.
ALTER TABLE profiles ADD COLUMN free_invites INTEGER CHECK (free_invites IS NULL OR free_invites >= 0);

-- Invitations the plan gives once, set at the first payment for it, and
-- when they open: 14 days later, once a withdrawal can no longer refund it.
ALTER TABLE profiles ADD COLUMN paid_invites INTEGER CHECK (paid_invites IS NULL OR paid_invites >= 0);
ALTER TABLE profiles ADD COLUMN paid_invites_at INTEGER;

WITH RECURSIVE tree (user_id, depth) AS (
  -- An inviter whose profile is gone still counts as a level.
  SELECT user_id, CASE WHEN invited_by IS NULL THEN 0 ELSE 1 END FROM profiles
  WHERE invited_by IS NULL OR invited_by NOT IN (SELECT user_id FROM profiles)
  UNION ALL
  SELECT child.user_id, tree.depth + 1 FROM profiles AS child JOIN tree ON child.invited_by = tree.user_id
)
UPDATE profiles SET invite_depth = (SELECT MAX(depth) FROM tree WHERE tree.user_id = profiles.user_id)
WHERE user_id IN (SELECT user_id FROM tree);

-- Fans who paid already get the plan's invitations, 14 days from their first payment.
UPDATE profiles SET
  paid_invites = COALESCE((SELECT value FROM settings WHERE key = 'invites_with_plan'), 5),
  paid_invites_at = (SELECT MIN(paid_at) FROM payments WHERE payments.user_id = profiles.user_id AND kind = 'plan') + 14 * 86400
WHERE EXISTS (SELECT 1 FROM payments WHERE payments.user_id = profiles.user_id AND kind = 'plan');

-- A partner link's share in steps: from so many months after a member
-- joins until so many, or for good. The link's terms are fixed with it.
CREATE TABLE partner_link_steps (
  code TEXT NOT NULL REFERENCES partner_links (code),
  from_month INTEGER NOT NULL CHECK (from_month >= 0),
  until_month INTEGER CHECK (until_month IS NULL OR until_month > from_month),
  share_percent INTEGER NOT NULL CHECK (share_percent BETWEEN 0 AND 100),
  PRIMARY KEY (code, from_month)
) STRICT, WITHOUT ROWID;

INSERT INTO partner_link_steps (code, from_month, until_month, share_percent)
SELECT code, 0, share_months, share_percent FROM partner_links;

ALTER TABLE partner_links DROP COLUMN share_percent;
ALTER TABLE partner_links DROP COLUMN share_months;

-- Free invitations each member who joins through the link gets, or null
-- for their level's.
ALTER TABLE partner_links ADD COLUMN free_invites INTEGER CHECK (free_invites IS NULL OR free_invites >= 0);

-- Payments gain the kind 'name': the 4-letter username, which partners do
-- not share. SQLite cannot widen a CHECK in place, so the table is rebuilt.
-- Nothing references it by foreign key.
CREATE TABLE payments_rebuilt (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'fresh_start', 'name')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  payment_intent TEXT,
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0)
) STRICT;

INSERT INTO payments_rebuilt (id, user_id, kind, amount_cents, currency, paid_at, payment_intent, refunded_cents)
SELECT id, user_id, kind, amount_cents, currency, paid_at, payment_intent, refunded_cents FROM payments;
DROP TABLE payments;
ALTER TABLE payments_rebuilt RENAME TO payments;

CREATE INDEX payments_user ON payments (user_id, paid_at);
CREATE INDEX payments_kind ON payments (kind, paid_at);
CREATE INDEX payments_intent ON payments (payment_intent) WHERE payment_intent IS NOT NULL;
