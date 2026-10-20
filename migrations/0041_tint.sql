-- Tint, a fan's choice in Settings under Display (app/lib/tint.ts): the
-- color in place of the board's orange, on their pages and in their emails,
-- while they have the plan. Null for orange.
ALTER TABLE profiles ADD COLUMN tint TEXT;
