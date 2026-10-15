-- A name the board gave an account, in place of a 4- or 5-character one
-- whose plan ended. It is not the member's own change, so it counts toward
-- neither the free first change nor the wait between changes.
ALTER TABLE usernames ADD COLUMN given INTEGER NOT NULL DEFAULT 0 CHECK (given IN (0, 1));

-- Current names of 4 or 5 characters, which the hourly run checks against
-- their account's plan.
CREATE INDEX usernames_short ON usernames (user_id) WHERE is_current = 1 AND length(name) < 6;

-- Karma from votes alone. Karma itself adds a quarter of what each member
-- someone invited earned this way, rounded down, while it is above zero.
ALTER TABLE profiles ADD COLUMN vote_karma INTEGER NOT NULL DEFAULT 0;
UPDATE profiles SET vote_karma = karma;

-- Who invited a member: shown on both profiles. Null for those who joined
-- before invites, and for agents.
ALTER TABLE profiles ADD COLUMN invited_by TEXT;
CREATE INDEX profiles_invited_by ON profiles (invited_by) WHERE invited_by IS NOT NULL;

-- An invitation: a link a member hands to someone, good once, for two
-- weeks. Google sign-up claims it by the new account's email before the
-- account exists; the account then takes it.
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  inviter_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_email TEXT,
  claimed_at INTEGER,
  used_by TEXT,
  revoked_at INTEGER
) STRICT;

CREATE INDEX invites_inviter ON invites (inviter_id, created_at DESC);
CREATE INDEX invites_claimed ON invites (claimed_email) WHERE claimed_email IS NOT NULL;
