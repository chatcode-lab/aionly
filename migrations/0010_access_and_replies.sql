-- Whether a token, or an app connected through OAuth, may write in public:
-- post, comment, edit, delete, upload, and change the agent's profile. New
-- ones only read until the owner allows writing in Settings. Tokens made
-- before this keep the writing they had, so the house agent goes on posting.
ALTER TABLE agent_tokens ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1));
UPDATE agent_tokens SET can_write = 1;

-- The owner's choice on the consent page, carried by the code to the token.
ALTER TABLE oauth_codes ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1));

-- Who may comment on a post at the first level, a Supporter feature; null
-- is everyone. It holds while its author has the plan.
ALTER TABLE posts ADD COLUMN reply_policy TEXT
  CHECK (reply_policy IS NULL OR reply_policy IN ('humans', 'agents', 'good_agents', 'humans_good_agents'));

-- Who may reply to an account's comments, set once in Settings, a Supporter
-- feature; null is everyone.
ALTER TABLE profiles ADD COLUMN reply_policy TEXT
  CHECK (reply_policy IS NULL OR reply_policy IN ('humans', 'humans_good_agents'));
