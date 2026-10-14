-- Sign-in, and the profile and post columns the participation steps need.

-- Foreign keys are checked once, when the migration commits, so rows can
-- briefly point at a table that is being rebuilt.
PRAGMA defer_foreign_keys = true;

-- Better Auth's tables, as its own schema generator writes them for SQLite.
-- They hold the Google identity and sessions and are never read by public
-- queries. Better Auth stores times as ISO strings and flags as 0 or 1.
CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");

-- Provider tokens are never kept: the board needs only who signed in.
CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE INDEX "account_userId_idx" ON "account" ("userId");

-- One board account per provider identity.
CREATE UNIQUE INDEX "account_provider_identity" ON "account" ("providerId", "accountId");

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- An agent's profile names the member who runs it. Agents arrive with the
-- house agent; until then every profile is a member's.
ALTER TABLE profiles ADD COLUMN owner_id TEXT REFERENCES profiles (user_id);

-- Per-account overrides set by an admin, such as a higher posting allowance.
ALTER TABLE profiles ADD COLUMN limits TEXT CHECK (limits IS NULL OR json_valid(limits));

-- A timed ban ends by itself at this time; null with `banned_at` set is
-- permanent.
ALTER TABLE profiles ADD COLUMN banned_until INTEGER;

-- Posts gain a kind. Every post in the MVP is a link; text posts and uploads
-- come with the paid plan and have no URL, so the URL and its duplicate key
-- become optional for them alone. SQLite cannot relax NOT NULL in place, so
-- the table is rebuilt.
--
-- Dropping a table counts every row that references it as a violation, and
-- the copy taking its name does not uncount them, so the referencing rows
-- are set aside first and restored after.
CREATE TABLE comments_aside AS SELECT * FROM comments;
CREATE TABLE bookmarks_aside AS SELECT * FROM bookmarks;
DELETE FROM bookmarks;
DELETE FROM comments;

CREATE TABLE posts_rebuilt (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES profiles (user_id),
  kind TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('link', 'text', 'upload')),
  url TEXT,
  canonical_key TEXT,
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
  removed_batch_id TEXT,
  CHECK ((kind = 'link') = (url IS NOT NULL AND canonical_key IS NOT NULL))
) STRICT;

INSERT INTO posts_rebuilt (
  id, author_id, kind, url, canonical_key, provider, origin, title,
  description, page_title, thumb_key, aspect, score, comment_count,
  created_at, edited_at, deleted_at, removed_batch_id
)
SELECT
  id, author_id, 'link', url, canonical_key, provider, origin, title,
  description, page_title, thumb_key, aspect, score, comment_count,
  created_at, edited_at, deleted_at, removed_batch_id
FROM posts;

DROP TABLE posts;

ALTER TABLE posts_rebuilt RENAME TO posts;

-- A link is taken while its post is live or moderator-removed, whether or not
-- the author also deleted it. Only an author-deleted, unremoved post frees it.
CREATE UNIQUE INDEX posts_canonical_key ON posts (canonical_key)
WHERE deleted_at IS NULL OR removed_batch_id IS NOT NULL;

CREATE INDEX posts_new ON posts (created_at DESC, id DESC);

CREATE INDEX posts_top ON posts (score DESC, created_at DESC, id DESC);

CREATE INDEX posts_author ON posts (author_id, created_at DESC);

INSERT INTO comments SELECT * FROM comments_aside;
INSERT INTO bookmarks SELECT * FROM bookmarks_aside;
DROP TABLE comments_aside;
DROP TABLE bookmarks_aside;
