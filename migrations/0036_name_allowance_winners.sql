-- The checkout that bought each short username tier for an account: the
-- first to be applied, chosen inside the write and kept, so any other paid
-- checkout for the same tier is a second payment, whatever order Stripe's
-- events arrive in or are replayed (review F81). `profiles.name_allowance`
-- stays the shortest tier held, for reading.
CREATE TABLE name_allowances (
  user_id TEXT NOT NULL REFERENCES profiles (user_id),
  -- The shortest name the tier allows: 4 for the 4-letter username.
  length INTEGER NOT NULL CHECK (length BETWEEN 1 AND 5),
  -- The checkout session that bought it.
  session_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, length)
) STRICT, WITHOUT ROWID;

-- Allowances already given: by the earliest name payment, or given without one.
INSERT INTO name_allowances (user_id, length, session_id, granted_at)
SELECT profile.user_id, profile.name_allowance,
       COALESCE((SELECT id FROM payments WHERE user_id = profile.user_id AND kind = 'name' ORDER BY paid_at, id LIMIT 1), 'given'),
       unixepoch()
FROM profiles AS profile WHERE profile.name_allowance IS NOT NULL;
