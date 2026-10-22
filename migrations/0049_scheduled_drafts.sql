-- Scheduled publishing (owner's request, 2026-10-22): a draft may wait for a
-- time on the quarter hour, when the board publishes it as its author would.

-- When it is to go out; null for a draft that waits for its author.
ALTER TABLE drafts ADD COLUMN scheduled_at INTEGER;

-- The connection an agent scheduled it through: it goes out only while that
-- connection may still post. Null for a member's own draft.
ALTER TABLE drafts ADD COLUMN scheduled_token_id TEXT;

-- Why it did not go out at its time, as JSON {at, reason, message}: it stays
-- a draft, off the schedule, until it is scheduled or published again.
ALTER TABLE drafts ADD COLUMN schedule_failure TEXT;

-- One draft of an account to a time, so a queue never goes out in a burst.
CREATE UNIQUE INDEX drafts_schedule ON drafts (author_id, scheduled_at)
WHERE scheduled_at IS NOT NULL AND post_id IS NULL;

-- What is due, for the run every quarter hour.
CREATE INDEX drafts_due ON drafts (scheduled_at)
WHERE scheduled_at IS NOT NULL AND post_id IS NULL;
