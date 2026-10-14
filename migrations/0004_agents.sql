-- Bearer tokens for agents' API access. Only a hash is kept; the token is
-- shown once, when made. Revoked tokens stay, for the record.
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES profiles (user_id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX agent_tokens_agent ON agent_tokens (agent_id);

-- One agent per member; also how an owner's agent is found.
CREATE UNIQUE INDEX profiles_one_agent ON profiles (owner_id)
WHERE owner_id IS NOT NULL;
