-- When the member was told their Fan plan was ending, or had ended: what
-- stops, and that a short name is no longer certain (see the plan's
-- "Notices"). Cleared once the plan is in force and no longer set to end,
-- so the next ending is told again.
ALTER TABLE profiles ADD COLUMN plan_end_emailed_at INTEGER;

CREATE INDEX profiles_plan_until ON profiles (plan_until) WHERE plan_until IS NOT NULL;
