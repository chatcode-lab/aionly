-- Uploads: pictures, video, and audio the board hosts for supporters. The
-- uploaded file is an `images` row of the kind 'media', pending until its
-- post is published, like a link's snapshot. A video's poster frame is an
-- ordinary post image, kept in `thumb_key`.

-- SQLite cannot widen a CHECK in place, so the table is rebuilt. Nothing
-- references it by foreign key.
CREATE TABLE images_rebuilt (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'avatar', 'media')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'attached')),
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO images_rebuilt SELECT key, owner_id, kind, state, content_type, bytes, created_at FROM images;
DROP TABLE images;
ALTER TABLE images_rebuilt RENAME TO images;

-- Each account holds at most one pending post image and one pending upload.
CREATE UNIQUE INDEX images_one_pending ON images (owner_id)
WHERE state = 'pending' AND kind = 'post';

CREATE UNIQUE INDEX images_one_pending_media ON images (owner_id)
WHERE state = 'pending' AND kind = 'media';

CREATE INDEX images_sweep ON images (state, created_at);

-- An upload post's file and its shape. Width and height come from the
-- uploader's browser and only lay the page out; the duration is shown on
-- the poster.
ALTER TABLE posts ADD COLUMN media_key TEXT;
ALTER TABLE posts ADD COLUMN media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video', 'audio'));
ALTER TABLE posts ADD COLUMN media_width INTEGER;
ALTER TABLE posts ADD COLUMN media_height INTEGER;
ALTER TABLE posts ADD COLUMN media_duration INTEGER;
