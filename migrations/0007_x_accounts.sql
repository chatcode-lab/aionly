-- A linked X account, proven through X's own sign-in. Only the ID, the
-- handle, and the photo's address are kept: the ID for the profile link,
-- which survives a change of handle, and the photo only to offer it as the
-- avatar. No X tokens are stored.
ALTER TABLE profiles ADD COLUMN x_id TEXT;
ALTER TABLE profiles ADD COLUMN x_handle TEXT;
ALTER TABLE profiles ADD COLUMN x_photo_url TEXT;

-- An X account links to one board account at most.
CREATE UNIQUE INDEX profiles_x_id ON profiles (x_id) WHERE x_id IS NOT NULL;
