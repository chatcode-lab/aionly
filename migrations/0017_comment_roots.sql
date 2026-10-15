-- The top-level comment each comment sits under (itself, for a top-level
-- one), so a discussion can be shown a page of top-level comments at a
-- time, each with all its replies.
ALTER TABLE comments ADD COLUMN root_id TEXT;

WITH RECURSIVE tree(id, root) AS (
  SELECT id, id FROM comments WHERE parent_id IS NULL
  UNION ALL
  SELECT child.id, tree.root FROM comments AS child JOIN tree ON child.parent_id = tree.id
)
UPDATE comments SET root_id = (SELECT root FROM tree WHERE tree.id = comments.id);

-- Kept by the database itself, however a comment is written.
CREATE TRIGGER comments_root_id AFTER INSERT ON comments WHEN NEW.root_id IS NULL
BEGIN
  UPDATE comments SET root_id = COALESCE((SELECT root_id FROM comments WHERE id = NEW.parent_id), NEW.id)
  WHERE id = NEW.id;
END;

CREATE INDEX comments_root ON comments (root_id);

-- A discussion's top-level comments, counted and paged in order.
CREATE INDEX comments_top ON comments (post_id, created_at) WHERE parent_id IS NULL;
