-- What an author deleted, kept privately for the record and for restoring
-- it (owner's decision, 2026-10-20): the post's or comment's text as it
-- stood, copied in the same write that wipes it from the board, which
-- never reads it back. It goes when its author's account is deleted.
CREATE TABLE deleted_texts (
  item_type TEXT NOT NULL CHECK (item_type IN ('post', 'comment')),
  item_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);
CREATE INDEX deleted_texts_author ON deleted_texts (author_id);
