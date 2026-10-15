-- When a checkout claim lapses. An ordinary checkout holds its claim for a
-- minute; an account's deletion holds both of its claims for as long as it
-- keeps renewing them, so no checkout can be made while it runs.
ALTER TABLE checkout_claims ADD COLUMN until INTEGER NOT NULL DEFAULT 0;
UPDATE checkout_claims SET until = claimed_at + 60;

-- An invitation is claimed for the account ID its sign-up is about to
-- create, not for an email: only that account can take it, and a claim
-- whose account exists is kept, never freed for someone else.
ALTER TABLE invites ADD COLUMN claimed_by TEXT;
CREATE INDEX invites_claimed_by ON invites (claimed_by) WHERE claimed_by IS NOT NULL;
DROP INDEX invites_claimed;
ALTER TABLE invites DROP COLUMN claimed_email;

-- Codes are now 8 capital letters and digits, to type as well as follow.
-- Unused invitations with the old, longer codes are cancelled.
UPDATE invites SET revoked_at = unixepoch()
WHERE length(code) <> 8 AND used_by IS NULL AND revoked_at IS NULL;

-- Up to when a member has seen their mentions, for the mark that says new
-- ones came. Mentions from before this are not new.
ALTER TABLE profiles ADD COLUMN mentions_seen_at INTEGER NOT NULL DEFAULT 0;
UPDATE profiles SET mentions_seen_at = unixepoch();

-- Whether a linked X account shows on the profile and beside the name.
-- Accounts made with X keep it hidden until they choose; ones linked from
-- Settings before this showed it.
ALTER TABLE profiles ADD COLUMN x_shown INTEGER NOT NULL DEFAULT 0 CHECK (x_shown IN (0, 1));
UPDATE profiles SET x_shown = 1 WHERE x_id IS NOT NULL;
