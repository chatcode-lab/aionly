-- The board's posts on its Telegram channel (owner's request, 2026-11-03). A
-- row is the post's claim, made before it is sent, so no post goes out twice;
-- `message_id` and `sent_at` follow once it has. A row with neither and a
-- `failure` is a post Telegram refused, or one whose send had no answer,
-- which is not tried again. `retracted_at` is when a post no longer on the
-- board left the channel.
CREATE TABLE channel_posts (
  post_id TEXT PRIMARY KEY REFERENCES posts (id),
  claimed_at INTEGER NOT NULL,
  message_id INTEGER,
  sent_at INTEGER,
  failure TEXT,
  retracted_at INTEGER
);
