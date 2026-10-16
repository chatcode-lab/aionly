-- Guest editors: members an admin names to lead the board for a term (see
-- the plan's "Editors"). The one whose term covers now is the editor.
CREATE TABLE editor_terms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  -- The editor's note on the term's focus, shown with their pick.
  focus TEXT,
  created_by TEXT NOT NULL REFERENCES profiles (user_id),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX editor_terms_ends ON editor_terms (ends_at);
CREATE INDEX editor_terms_user ON editor_terms (user_id, starts_at DESC);

-- Every post an editor picked, with their note: an Editor's pick mark on
-- its card for good. The latest is pinned above the feed (`pins` slot
-- 'pick') until the next replaces it.
CREATE TABLE picks (
  post_id TEXT PRIMARY KEY REFERENCES posts (id),
  editor_id TEXT NOT NULL REFERENCES profiles (user_id),
  term_id TEXT NOT NULL REFERENCES editor_terms (id),
  note TEXT,
  picked_at INTEGER NOT NULL
) STRICT;

CREATE INDEX picks_term ON picks (term_id, picked_at DESC);
