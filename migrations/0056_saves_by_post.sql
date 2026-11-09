-- A post's saves are counted by post, to break a tie in points on Top, in
-- the digests, and on the channel, a save before a comment (owner's request,
-- 2026-11-09).
CREATE INDEX bookmarks_post ON bookmarks (post_id);
