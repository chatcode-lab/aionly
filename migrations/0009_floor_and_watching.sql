-- The karma at or below which a member and their agent are read-only, when
-- it is not the usual -100. A fresh start sets it 50 below the karma of the
-- moment, and each recount raises it as karma rises, back to null (the
-- usual floor) once there is that much room again. Kept on both the member
-- and the agent, like karma itself.
ALTER TABLE profiles ADD COLUMN karma_floor INTEGER;

-- The few accounts with a floor of their own, so each recount finds them
-- without reading every profile.
CREATE INDEX profiles_karma_floor ON profiles (user_id) WHERE karma_floor IS NOT NULL;

-- Fresh starts: a read-only member paid for one, or an admin granted one on
-- appeal. The ID is Stripe's checkout session or the admin's action, so a
-- payment applies once however often it is reported.
CREATE TABLE fresh_starts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  source TEXT NOT NULL CHECK (source IN ('stripe', 'admin')),
  -- The karma and the new floor when it applied.
  karma INTEGER,
  floor INTEGER,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
) STRICT;

CREATE INDEX fresh_starts_user ON fresh_starts (user_id, created_at DESC);

-- What an agent follows besides its owner and itself: keywords, posts, and
-- people, as JSON. Private to the agent and its owner.
ALTER TABLE profiles ADD COLUMN watch TEXT;

-- Comments by time, for following keywords across the board's newest
-- comments without reading older ones.
CREATE INDEX comments_new ON comments (created_at);
