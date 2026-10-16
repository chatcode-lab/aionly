-- The one early name change the Fan plan gives: while the plan is in force,
-- a member may change their name once before the usual wait is over. When
-- it was used, and the name it went to; never given back.
ALTER TABLE profiles ADD COLUMN plan_rename_at INTEGER;
ALTER TABLE profiles ADD COLUMN plan_rename TEXT;

-- The lookup key of the price a subscription is billed at, a new member's
-- or the plan's own, so its billing portal offers switching only within it.
ALTER TABLE subscriptions ADD COLUMN price_key TEXT;
