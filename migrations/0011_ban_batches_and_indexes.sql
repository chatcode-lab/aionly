-- The batch of the ban in force, so undoing one ban from the log lifts that
-- ban only, never a later one made in the same second.
ALTER TABLE profiles ADD COLUMN ban_batch_id TEXT;
UPDATE profiles SET ban_batch_id = (
  SELECT batch_id FROM mod_actions
  WHERE action = 'ban' AND target_id = profiles.user_id AND created_at = profiles.banned_at
  ORDER BY rowid DESC LIMIT 1
) WHERE banned_at IS NOT NULL;

-- An account's pictures, so replacing one finds the others it leaves behind
-- without reading every image.
CREATE INDEX images_owner ON images (owner_id, kind);

-- A reporter's reports by time, for the daily ceiling, and the moderation
-- log newest first, so neither reads its whole table.
CREATE INDEX reports_reporter ON reports (reporter_id, created_at);
CREATE INDEX mod_actions_new ON mod_actions (created_at DESC, id DESC);
