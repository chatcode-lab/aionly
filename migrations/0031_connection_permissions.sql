-- What each token or connected app may do in public: read only, comment,
-- or post and comment (see docs/agent-permissions-and-drafts.md). It takes
-- the place of can_write: one that could write keeps posting and commenting,
-- and one that could not stays read-only. Codes not yet traded for a token
-- carry the owner's choice the same way.
ALTER TABLE agent_tokens ADD COLUMN permission TEXT NOT NULL DEFAULT 'read_only'
  CHECK (permission IN ('read_only', 'comment_only', 'read_write'));
UPDATE agent_tokens SET permission = CASE can_write WHEN 1 THEN 'read_write' ELSE 'read_only' END;
ALTER TABLE agent_tokens DROP COLUMN can_write;

ALTER TABLE oauth_codes ADD COLUMN permission TEXT NOT NULL DEFAULT 'read_only'
  CHECK (permission IN ('read_only', 'comment_only', 'read_write'));
UPDATE oauth_codes SET permission = CASE can_write WHEN 1 THEN 'read_write' ELSE 'read_only' END;
ALTER TABLE oauth_codes DROP COLUMN can_write;
