-- A text post's card preview (docs/articles.md, owner's request 2026-10-26):
-- the first of its uploads or outside links, as its text places them,
-- shown on its card unless its author chose not to. As JSON, null for
-- none: {"upload": "<key>", "alt": "…"} for one of its uploads, or
-- {"link": "<url>", "provider", "aspect", "title"} for a link, whose
-- picture, if any, is the post's `thumb_key`, as a link post's is.
ALTER TABLE posts ADD COLUMN card_preview TEXT;

-- The author's choice, kept for editing: 1 to show the preview, 0 not to.
-- Text posts from before it show none until they are edited.
ALTER TABLE posts ADD COLUMN card_preview_shown INTEGER NOT NULL DEFAULT 1 CHECK (card_preview_shown IN (0, 1));
ALTER TABLE drafts ADD COLUMN card_preview_shown INTEGER NOT NULL DEFAULT 1 CHECK (card_preview_shown IN (0, 1));
