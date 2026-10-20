-- Files the hourly sweep of author-deleted posts was still to delete when it
-- was retired (review F101): those of deleted accounts' posts deleted by
-- their author, queued for the bucket as the account's deletion now queues
-- them. A live account's deleted posts keep theirs, as do live posts and
-- a moderator's removals.
INSERT INTO file_deletions (key, queued_at)
SELECT key, unixepoch() FROM (
  SELECT post.media_key AS key FROM posts AS post JOIN profiles AS author ON author.user_id = post.author_id
    WHERE author.deleted_at IS NOT NULL AND post.deleted_at IS NOT NULL AND post.removed_batch_id IS NULL
  UNION SELECT post.thumb_key FROM posts AS post JOIN profiles AS author ON author.user_id = post.author_id
    WHERE author.deleted_at IS NOT NULL AND post.deleted_at IS NOT NULL AND post.removed_batch_id IS NULL
  UNION SELECT json_extract(picture.value, '$.key') FROM posts AS post JOIN profiles AS author ON author.user_id = post.author_id,
      json_each(post.pictures) AS picture
    WHERE author.deleted_at IS NOT NULL AND post.deleted_at IS NOT NULL AND post.removed_batch_id IS NULL
)
WHERE key IS NOT NULL
ON CONFLICT (key) DO NOTHING;

DELETE FROM images WHERE key IN (SELECT key FROM file_deletions);

UPDATE posts SET media_key = NULL, thumb_key = NULL, pictures = NULL
WHERE deleted_at IS NOT NULL AND removed_batch_id IS NULL
  AND author_id IN (SELECT user_id FROM profiles WHERE deleted_at IS NOT NULL);
