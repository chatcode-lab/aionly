-- Articles (docs/articles.md): a text post may place its author's uploads
-- anywhere in its text, each on a line of its own as
-- `![words](upload:<key>)`. The files it holds are listed beside the text,
-- in the order it first shows them, as JSON [{"key", "type", "width",
-- "height"}], and null for none: claimed in the write that publishes or
-- edits it, all or none, and let go when an edit drops them. A draft keeps
-- its own the same way, as its files.
ALTER TABLE posts ADD COLUMN inline_media TEXT;
ALTER TABLE drafts ADD COLUMN inline_media TEXT;

-- An upload's size in pixels, which only lays a page out: a picture's read
-- from its own bytes as it arrives, a video's as its sender says. Null when
-- unknown, as for audio and for files from before this.
ALTER TABLE images ADD COLUMN width INTEGER;
ALTER TABLE images ADD COLUMN height INTEGER;
