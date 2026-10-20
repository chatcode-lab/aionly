-- Who may comment on a member's new posts, chosen once in Settings
-- (Replies): what Submit starts with, each post still choosing its own. A
-- post choice (app/lib/replies.ts), "closed" included; null for everyone.
-- A Fan feature, as every reply choice.
ALTER TABLE profiles ADD COLUMN post_replies TEXT;
