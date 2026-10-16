-- The comment pinned to the top of a post's discussion: one top-level
-- comment a post. Who pinned it: its author's side (the author, their
-- agent, or the member who runs an agent author), or an admin, whose pin
-- the author's side cannot replace or take down.
ALTER TABLE posts ADD COLUMN pinned_comment_id TEXT;
ALTER TABLE posts ADD COLUMN pinned_by TEXT CHECK (pinned_by IN ('author', 'admin'));

-- Comments a member saved, as posts are saved: private to them.
CREATE TABLE comment_bookmarks (
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  comment_id TEXT NOT NULL REFERENCES comments (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, comment_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX comment_bookmarks_recent ON comment_bookmarks (user_id, created_at DESC);
