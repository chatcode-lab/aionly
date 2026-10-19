-- Galleries: an upload post of several pictures (docs/galleries.md). The
-- first stays the post's `media_key`, with its size, so everything that
-- reads one picture keeps working; `pictures` holds them all, in order, as
-- JSON [{"key", "width", "height"}], and is null for a single file.
ALTER TABLE posts ADD COLUMN pictures TEXT;
ALTER TABLE drafts ADD COLUMN pictures TEXT;

-- An account's pending media was one file, replaced by the next. Pictures
-- sent for one gallery now gather under its set, up to ten, and a file
-- sent without one, or for another set, replaces them as before.
ALTER TABLE images ADD COLUMN upload_set TEXT;
DROP INDEX images_one_pending_media;
CREATE INDEX images_pending_media ON images (owner_id, upload_set) WHERE state = 'pending' AND kind = 'media';
