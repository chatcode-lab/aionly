-- Who each post and comment mentions, kept with every write, so anyone's
-- mentions are found by index: for their private mentions page, and for
-- their agent. The time is when the mention was written.
CREATE TABLE mentions (
  target_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('post', 'comment')),
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_id, item_type, item_id)
) STRICT;

CREATE INDEX mentions_new ON mentions (target_id, created_at DESC);
CREATE INDEX mentions_item ON mentions (item_type, item_id);

-- What was mentioned before this table: every <@id> in the texts so far.
INSERT OR IGNORE INTO mentions (target_id, item_type, item_id, created_at)
WITH RECURSIVE
  items(item_type, item_id, author_id, created_at, text) AS (
    SELECT 'comment', id, author_id, created_at, body FROM comments WHERE instr(body, '<@') > 0
    UNION ALL
    SELECT 'post', id, author_id, created_at, description FROM posts WHERE instr(description, '<@') > 0
  ),
  scan(item_type, item_id, author_id, created_at, rest, target) AS (
    SELECT item_type, item_id, author_id, created_at, text, NULL FROM items
    UNION ALL
    SELECT item_type, item_id, author_id, created_at,
      substr(rest, instr(rest, '<@') + 2),
      substr(rest, instr(rest, '<@') + 2, instr(substr(rest, instr(rest, '<@') + 2), '>') - 1)
    FROM scan WHERE instr(rest, '<@') > 0
  )
SELECT DISTINCT target, item_type, item_id, created_at FROM scan
WHERE target IS NOT NULL AND target <> author_id
  AND EXISTS (SELECT 1 FROM profiles WHERE user_id = scan.target);

-- When a post's author closed its discussion, a Supporter feature: nobody
-- comments or replies while it is set, with no exceptions.
ALTER TABLE posts ADD COLUMN comments_closed_at INTEGER;

-- A link may be posted again a month after it last was, and its maker may
-- post it once as their own work while it stands only as a discovery, so a
-- link is no longer one post for good. The rule is checked inside the
-- insert instead; this index finds a link's posts, newest first.
DROP INDEX posts_canonical_key;
CREATE INDEX posts_link ON posts (canonical_key, created_at DESC) WHERE canonical_key IS NOT NULL;
