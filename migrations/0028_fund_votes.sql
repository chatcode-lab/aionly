-- Members choose where the fund gives (see the plan's "The fund"): an admin
-- opens a vote by linking a post, where each top-level comment names a
-- cause and votes decide; the chosen cause records the vote it came from.
CREATE TABLE fund_votes (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts (id),
  -- When nominations close.
  closes_at INTEGER NOT NULL,
  opened_by TEXT NOT NULL REFERENCES profiles (user_id),
  opened_at INTEGER NOT NULL,
  -- When an admin chose the winning cause, or null while open.
  decided_at INTEGER
) STRICT;

CREATE INDEX fund_votes_opened ON fund_votes (opened_at DESC);

ALTER TABLE fund_causes ADD COLUMN vote_id TEXT REFERENCES fund_votes (id);

-- X's own picture for an account without one is not a photo of anyone.
UPDATE profiles SET x_photo_url = NULL WHERE x_photo_url LIKE '%/default_profile_images/%';
