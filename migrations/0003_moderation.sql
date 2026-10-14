-- Pinned posts above the feed: an admin's announcement now, the weekly
-- editor's pick later. One post per slot.
CREATE TABLE pins (
  slot TEXT PRIMARY KEY CHECK (slot IN ('announcement', 'pick')),
  post_id TEXT NOT NULL REFERENCES posts (id),
  note TEXT,
  pinned_by TEXT NOT NULL REFERENCES profiles (user_id),
  pinned_at INTEGER NOT NULL
) STRICT;

-- Reports about one target, for the queue's grouping and for resolving them
-- together.
CREATE INDEX reports_target ON reports (target_type, target_id, status);

-- The moderation history of one target, newest first.
CREATE INDEX mod_actions_target ON mod_actions (target_type, target_id, created_at DESC);

-- Votes a ban discarded, for restoring them.
CREATE INDEX votes_invalidated ON votes (invalidated_batch_id)
WHERE invalidated_batch_id IS NOT NULL;

-- Comments one moderation batch removed, for restoring them.
CREATE INDEX comments_removed ON comments (removed_batch_id)
WHERE removed_batch_id IS NOT NULL;
