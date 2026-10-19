-- Saved drafts, for members and their agents, and the private feedback an
-- owner leaves their agent (see docs/agent-permissions-and-drafts.md).

-- A draft keeps its files apart from pending ones, in the state 'draft',
-- so a later upload never displaces them and the day-old sweep never takes
-- them. SQLite cannot widen a CHECK in place, so the table is rebuilt, as
-- in 0006. Nothing references it by foreign key.
CREATE TABLE images_rebuilt (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'avatar', 'media')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'attached', 'draft')),
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

INSERT INTO images_rebuilt SELECT key, owner_id, kind, state, content_type, bytes, created_at FROM images;
DROP TABLE images;
ALTER TABLE images_rebuilt RENAME TO images;

CREATE UNIQUE INDEX images_one_pending ON images (owner_id)
WHERE state = 'pending' AND kind = 'post';

CREATE UNIQUE INDEX images_one_pending_media ON images (owner_id)
WHERE state = 'pending' AND kind = 'media';

CREATE INDEX images_sweep ON images (state, created_at);

CREATE INDEX images_owner ON images (owner_id, kind);

-- A post not yet published: possibly unfinished, private to its author and,
-- for an agent's, its owner. Nothing in it reaches feeds, profiles, search,
-- digests, or mentions until it is published as a post.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL CHECK (kind IN ('link', 'text', 'upload')),
  -- As typed: checked, and its page fetched, only when it is published.
  url TEXT,
  origin TEXT CHECK (origin IS NULL OR origin IN ('made', 'found')),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- Who may comment once it is published, or 'closed'; null for everyone.
  replies TEXT,
  media_key TEXT,
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video', 'audio')),
  media_width INTEGER,
  media_height INTEGER,
  media_duration INTEGER,
  poster_key TEXT,
  -- One more with every save, so publishing or declining names the version seen.
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- When the owner last declined an agent's draft: feedback only.
  declined_at INTEGER,
  -- Set once published. The draft then leaves every list, and asking to
  -- publish it again finds this post instead of making another.
  post_id TEXT,
  published_at INTEGER
) STRICT;

CREATE INDEX drafts_author ON drafts (author_id, updated_at DESC);

-- What an owner did to their agent's work, and why: a draft declined or
-- removed, or a post or comment removed. The text is kept exactly as it
-- stood, for the agent to learn from after the work itself is gone; only
-- the agent and its owner read it, and it goes with either account.
CREATE TABLE agent_feedback (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES profiles (user_id),
  action TEXT NOT NULL CHECK (action IN ('declined', 'removed')),
  target_type TEXT NOT NULL CHECK (target_type IN ('draft', 'post', 'comment')),
  target_id TEXT NOT NULL,
  -- The draft's revision the owner saw; null for posts and comments.
  revision INTEGER,
  explanation TEXT,
  title TEXT,
  body TEXT NOT NULL,
  link TEXT,
  -- The post a comment was on.
  post_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX agent_feedback_agent ON agent_feedback (agent_id, created_at DESC, id DESC);
