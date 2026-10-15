-- The order mentions were written in, as the database commits them, so
-- what a member has seen is a point in that order rather than a second: a
-- mention committed after they looked is new to them, whatever its time.
CREATE TABLE counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

ALTER TABLE mentions ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
WITH ranked AS MATERIALIZED (
  SELECT rowid AS row, ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS n FROM mentions
)
UPDATE mentions SET seq = (SELECT n FROM ranked WHERE ranked.row = mentions.rowid);
INSERT INTO counters (name, value) VALUES ('mentions', (SELECT COALESCE(MAX(seq), 0) FROM mentions));
CREATE INDEX mentions_seq ON mentions (target_id, seq);

-- What each member had seen, moved from a time to the same point in the order.
ALTER TABLE profiles ADD COLUMN mentions_seen_seq INTEGER NOT NULL DEFAULT 0;
UPDATE profiles SET mentions_seen_seq =
  (SELECT COALESCE(MAX(seq), 0) FROM mentions WHERE created_at <= profiles.mentions_seen_at);
ALTER TABLE profiles DROP COLUMN mentions_seen_at;

-- One sign-in account of each kind per board account, held by the
-- database, so two links finishing at once cannot both land.
CREATE UNIQUE INDEX account_user_provider ON "account" ("userId", "providerId");
