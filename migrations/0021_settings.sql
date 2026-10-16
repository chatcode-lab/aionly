-- The board's numbers that admins tune at any time, in /admin/settings
-- (app/lib/settings.ts has each one's default and range). A row exists
-- only once a value was changed; SQL reads the one in force inside each
-- write. Every change is logged in mod_actions as set_setting.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES profiles (user_id)
) STRICT, WITHOUT ROWID;
