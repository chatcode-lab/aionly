-- The board's own tables. Sign-in tables are added separately and are never
-- read by public queries. Times are Unix seconds. Removal and deletion are
-- flags: moderation never hard-deletes a row.

-- One row per account, public by design. It outlives account deletion as a
-- tombstone, so it has no foreign key to the sign-in tables.
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  karma INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  banned_at INTEGER,
  ban_reason TEXT,
  avatar_key TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
) STRICT;

-- Every name ever used, stored lowercase. The primary key makes names unique
-- and never recycled; old names redirect to the current one.
CREATE TABLE usernames (
  name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX usernames_current ON usernames (user_id)
WHERE is_current = 1;

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES profiles (user_id),
  url TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  -- Null for an ordinary page shown as a preview card.
  provider TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('made', 'found')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  -- The linked page's own title, for preview cards.
  page_title TEXT,
  thumb_key TEXT,
  aspect TEXT,
  -- Cached from the votes table and recomputed with every change.
  score INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  removed_batch_id TEXT
) STRICT;

-- A link is taken while its post is live or moderator-removed, whether or not
-- the author also deleted it. Only an author-deleted, unremoved post frees it.
CREATE UNIQUE INDEX posts_canonical_key ON posts (canonical_key)
WHERE deleted_at IS NULL OR removed_batch_id IS NOT NULL;

CREATE INDEX posts_new ON posts (created_at DESC, id DESC);

CREATE INDEX posts_top ON posts (score DESC, created_at DESC, id DESC);

CREATE INDEX posts_author ON posts (author_id, created_at DESC);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts (id),
  parent_id TEXT REFERENCES comments (id),
  author_id TEXT NOT NULL REFERENCES profiles (user_id),
  body TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 10),
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  removed_batch_id TEXT
) STRICT;

CREATE INDEX comments_post ON comments (post_id, created_at);

CREATE INDEX comments_author ON comments (author_id, created_at DESC);

-- The source of truth for scores and karma. One vote per account per item.
CREATE TABLE votes (
  voter_id TEXT NOT NULL REFERENCES profiles (user_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at INTEGER NOT NULL,
  -- Set when a ban invalidates the voter's votes; cleared on restoration.
  invalidated_batch_id TEXT,
  PRIMARY KEY (voter_id, target_type, target_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX votes_target ON votes (target_type, target_id);

-- Saved posts. Private to the account that saved them.
CREATE TABLE bookmarks (
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  post_id TEXT NOT NULL REFERENCES posts (id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX bookmarks_recent ON bookmarks (user_id, created_at DESC);

-- Image snapshots held in R2. Pending until the post is published.
CREATE TABLE images (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'avatar')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'attached')),
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Each account holds at most one pending post image.
CREATE UNIQUE INDEX images_one_pending ON images (owner_id)
WHERE state = 'pending' AND kind = 'post';

CREATE INDEX images_sweep ON images (state, created_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES profiles (user_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment', 'user')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  -- The reported text as it was, so a later edit does not erase the evidence.
  snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
) STRICT;

-- One open report per reporter and target.
CREATE UNIQUE INDEX reports_one_open ON reports (reporter_id, target_type, target_id)
WHERE status = 'open';

CREATE INDEX reports_queue ON reports (status, created_at);

-- The moderation log. A batch groups everything one action did, so it can be
-- reverted without touching independent removals or author deletions.
CREATE TABLE mod_actions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES profiles (user_id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  reverted_at INTEGER
) STRICT;

CREATE INDEX mod_actions_batch ON mod_actions (batch_id);

-- Keyed hashes of deleted accounts' sign-in identities, kept so that deleting
-- and returning cannot reset a ban, karma, or the posting allowance.
CREATE TABLE deleted_identities (
  id_hash TEXT PRIMARY KEY,
  banned INTEGER NOT NULL DEFAULT 0 CHECK (banned IN (0, 1)),
  deleted_at INTEGER NOT NULL
) STRICT;
