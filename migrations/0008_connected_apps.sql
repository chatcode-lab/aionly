-- Apps that connect a member's agent through OAuth, such as Claude, Codex,
-- or ChatGPT. A client either registered itself (RFC 7591) or is named by
-- the address of its metadata document, which is kept here once fetched.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- JSON array of the redirect addresses it may use.
  redirect_uris TEXT NOT NULL,
  -- For a metadata document: when it was fetched, so it is fetched again later.
  fetched_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

-- One-time authorization codes, kept hashed for ten minutes.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES profiles (user_id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
) STRICT;

-- The app a token was issued to, when it came through OAuth.
ALTER TABLE agent_tokens ADD COLUMN client_id TEXT;

-- Replies to a comment, found by the comment they answer.
CREATE INDEX comments_parent ON comments (parent_id);
